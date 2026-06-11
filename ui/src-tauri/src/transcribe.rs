//! Transcription workflow: extract audio, run MLX Whisper, and write
//! subtitles (.srt/.vtt) plus a raw transcript (.txt) beside the source.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::Duration,
};
use tauri::AppHandle;

use crate::events::{emit_log, emit_progress, emit_status};
use crate::media::{Ffmpeg, MediaProbe};
use crate::process::{format_clock, run_logged_command_observed, ConversionState};
use crate::runtime::{
    prepend_runtime_path, probe_processor_paths, processor_paths, ProcessorPaths,
};

const SUPPORTED_FORMATS: [&str; 5] = ["srt", "vtt", "txt", "tsv", "json"];

// (HF repo id, label, approximate download size in MB). Sizes are only used
// for download progress estimates and the size hint in the picker.
const WHISPER_MODELS: &[(&str, &str, u64)] = &[
    ("mlx-community/whisper-tiny", "Tiny — fastest, rough", 80),
    ("mlx-community/whisper-small-mlx", "Small — balanced", 480),
    ("mlx-community/whisper-medium", "Medium — high accuracy", 1500),
    (
        "mlx-community/whisper-large-v3-turbo",
        "Large v3 Turbo — best quality",
        1700,
    ),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscribeOptions {
    pub(crate) video_path: String,
    pub(crate) language: String,
    pub(crate) model: String,
    pub(crate) formats: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelDownloadOptions {
    pub(crate) model: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WhisperModelInfo {
    id: String,
    label: String,
    size_mb: u64,
    downloaded: bool,
}

fn model_entry(id: &str) -> Result<&'static (&'static str, &'static str, u64), String> {
    WHISPER_MODELS
        .iter()
        .find(|(model_id, _, _)| *model_id == id)
        .ok_or_else(|| format!("Unknown Whisper model: {id}."))
}

pub(crate) fn model_cache_dir(hf_home: &Path, id: &str) -> PathBuf {
    hf_home
        .join("hub")
        .join(format!("models--{}", id.replace('/', "--")))
}

// A model counts as downloaded when a snapshot contains a resolvable weights
// file. Hub snapshots are symlinks into blobs/, and the symlink only resolves
// once the blob finished downloading.
fn model_downloaded(hf_home: &Path, id: &str) -> bool {
    let snapshots = model_cache_dir(hf_home, id).join("snapshots");
    let Ok(revisions) = fs::read_dir(snapshots) else {
        return false;
    };
    revisions
        .filter_map(Result::ok)
        .flat_map(|revision| fs::read_dir(revision.path()).into_iter().flatten())
        .filter_map(Result::ok)
        .any(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            (name.ends_with(".npz") || name.ends_with(".safetensors")) && entry.path().exists()
        })
}

pub(crate) fn list_models(app: &AppHandle) -> Result<Vec<WhisperModelInfo>, String> {
    let hf_home = probe_processor_paths(app)?.hf_home;
    Ok(WHISPER_MODELS
        .iter()
        .map(|(id, label, size_mb)| WhisperModelInfo {
            id: (*id).into(),
            label: (*label).into(),
            size_mb: *size_mb,
            downloaded: model_downloaded(&hf_home, id),
        })
        .collect())
}

pub(crate) fn validated_model(id: &str) -> Result<String, String> {
    model_entry(id).map(|(model_id, _, _)| (*model_id).to_string())
}

fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .filter_map(Result::ok)
        .map(|entry| {
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                return 0;
            };
            if metadata.is_dir() {
                dir_size(&path)
            } else if metadata.is_file() {
                metadata.len()
            } else {
                0
            }
        })
        .sum()
}

pub(crate) fn run_model_download(
    app: &AppHandle,
    state: &ConversionState,
    model_id: &str,
) -> Result<(), String> {
    let (id, _, size_mb) = *model_entry(model_id)?;
    let paths = processor_paths(app, state)?;
    if model_downloaded(&paths.hf_home, id) {
        return Ok(());
    }

    emit_status(
        app,
        "running",
        "setup",
        "Downloading the Whisper model",
        None,
    );

    // huggingface_hub reports its progress with carriage returns that never
    // reach a line-based reader, so estimate progress from the on-disk size
    // of the model's cache directory instead.
    let cache_dir = model_cache_dir(&paths.hf_home, id);
    let stop_polling = Arc::new(AtomicBool::new(false));
    let poller = {
        let stop_polling = Arc::clone(&stop_polling);
        let app = app.clone();
        let cache_dir = cache_dir.clone();
        thread::spawn(move || {
            while !stop_polling.load(Ordering::SeqCst) {
                let downloaded_mb = dir_size(&cache_dir) / (1024 * 1024);
                let percent =
                    ((downloaded_mb as f64 / size_mb as f64) * 100.0).clamp(0.0, 99.0);
                emit_progress(
                    &app,
                    Some(percent),
                    format!("{downloaded_mb} MB of ~{size_mb} MB"),
                );
                thread::sleep(Duration::from_secs(1));
            }
        })
    };

    let mut command = Command::new(&paths.python);
    command
        .args([
            "-c",
            "import sys\nfrom huggingface_hub import snapshot_download\nsnapshot_download(repo_id=sys.argv[1])\nprint('Model download complete:', sys.argv[1])",
        ])
        .arg(id)
        .env("HF_HUB_DISABLE_PROGRESS_BARS", "1");
    prepend_runtime_path(&mut command, &paths);
    let result = run_logged_command_observed(app, state, &mut command, |_, _| {});

    stop_polling.store(true, Ordering::SeqCst);
    let _ = poller.join();
    result?;

    if model_downloaded(&paths.hf_home, id) {
        emit_progress(app, Some(100.0), "Model downloaded");
        Ok(())
    } else {
        Err("The model download did not complete.".into())
    }
}

/// Validates and dedupes the requested output formats, preserving order.
pub(crate) fn normalized_formats(raw: &[String]) -> Result<Vec<String>, String> {
    let mut formats = Vec::new();
    for format in raw {
        let format = format.trim().to_ascii_lowercase();
        if !SUPPORTED_FORMATS.contains(&format.as_str()) {
            return Err(format!("Unsupported transcript format: {format}."));
        }
        if !formats.contains(&format) {
            formats.push(format);
        }
    }
    if formats.is_empty() {
        return Err("Choose at least one output format.".into());
    }
    Ok(formats)
}

pub(crate) fn transcript_base_name(video_path: &Path, language: &str) -> Result<String, String> {
    let stem = video_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("The selected video filename is invalid.")?;
    if language == "auto" {
        Ok(stem.to_string())
    } else {
        Ok(format!("{stem}.{language}"))
    }
}

/// Whisper prints each segment as "[01:02.000 --> 01:05.000]  text"; the end
/// timestamp tells us how far into the audio the transcription has reached.
fn segment_end_seconds(line: &str) -> Option<f64> {
    let (_, rest) = line.split_once("-->")?;
    let (timestamp, _) = rest.split_once(']')?;
    clock_seconds(timestamp.trim())
}

fn clock_seconds(raw: &str) -> Option<f64> {
    let mut total = 0.0;
    for part in raw.split(':') {
        total = total * 60.0 + part.trim().parse::<f64>().ok()?;
    }
    Some(total)
}

#[cfg(test)]
mod tests {
    use super::segment_end_seconds;

    #[test]
    fn parses_minute_second_segments() {
        assert_eq!(
            segment_end_seconds("[00:08.000 --> 00:09.500]  Nein, nein."),
            Some(9.5)
        );
    }

    #[test]
    fn parses_hour_segments() {
        assert_eq!(
            segment_end_seconds("[01:02:03.000 --> 01:02:05.250]  Hallo."),
            Some(3725.25)
        );
    }

    #[test]
    fn ignores_non_segment_lines() {
        assert_eq!(segment_end_seconds("Detected language: German"), None);
        assert_eq!(segment_end_seconds("  0%|          | 0/1 [00:00]"), None);
    }
}

pub(crate) fn run_transcribe(
    app: &AppHandle,
    state: &ConversionState,
    options: &TranscribeOptions,
    base_name: &str,
) -> Result<(), String> {
    let video_path = PathBuf::from(&options.video_path);
    let formats = normalized_formats(&options.formats)?;
    let output_dir = video_path
        .parent()
        .map(Path::to_path_buf)
        .ok_or("The selected file has no parent directory.")?;
    let paths = processor_paths(app, state)?;
    let mlx_whisper = paths.venv_dir.join("bin/mlx_whisper");
    if !mlx_whisper.is_file() {
        return Err(format!("mlx_whisper not found at {}.", mlx_whisper.display()));
    }

    let work_dir = output_dir.join(format!("{base_name}.transcribe-tmp"));
    fs::create_dir_all(&work_dir)
        .map_err(|error| format!("Could not create {}: {error}", work_dir.display()))?;

    let model = validated_model(&options.model)?;
    let result = run_transcribe_steps(
        app,
        state,
        &paths,
        &video_path,
        &work_dir,
        &output_dir,
        base_name,
        &options.language,
        &model,
        &formats,
    );
    let _ = fs::remove_dir_all(&work_dir);
    result
}

#[allow(clippy::too_many_arguments)]
fn run_transcribe_steps(
    app: &AppHandle,
    state: &ConversionState,
    paths: &ProcessorPaths,
    video_path: &Path,
    work_dir: &Path,
    output_dir: &Path,
    base_name: &str,
    language: &str,
    model: &str,
    formats: &[String],
) -> Result<(), String> {
    let audio_path = work_dir.join("audio.wav");
    let duration = MediaProbe::new(paths).duration(video_path);
    emit_status(
        app,
        "running",
        "extract",
        "Extracting audio for Whisper",
        None,
    );
    Ffmpeg::new(paths)?
        .input(video_path)
        .first_audio_only()
        .whisper_wav()
        .output(&audio_path)
        .run(app, state, duration)?;

    emit_status(
        app,
        "running",
        "transcribe",
        "Transcribing with MLX Whisper",
        None,
    );
    // The extract phase left the bar at 100%; drop it back to zero while the
    // model loads, which can take a while before the first segment appears.
    emit_progress(
        app,
        Some(0.0),
        "Loading the Whisper model and decoding the first segment...",
    );
    // mlx_whisper treats everything after the last dot in --output-name as an
    // extension and strips it, which mangles dotted movie names. Transcribe to
    // a fixed dot-free name and rename to the real base name afterwards.
    let mut command = Command::new(paths.venv_dir.join("bin/mlx_whisper"));
    command
        .arg(&audio_path)
        .args(["--model", model])
        .args(["--output-format", "all"])
        .arg("--output-dir")
        .arg(work_dir)
        .args(["--output-name", "transcript"])
        .args(["--condition-on-previous-text", "False"]);
    if language != "auto" {
        command.args(["--language", language]);
    }
    prepend_runtime_path(&mut command, paths);
    run_logged_command_observed(app, state, &mut command, move |app, line| {
        let Some(seconds) = segment_end_seconds(line) else {
            return;
        };
        let percent = duration
            .filter(|duration| *duration > 0.0)
            .map(|duration| (seconds / duration * 100.0).clamp(0.0, 100.0));
        let mut detail = format_clock(seconds);
        if let Some(duration) = duration {
            detail.push_str(&format!(" / {}", format_clock(duration)));
        }
        detail.push_str(" transcribed");
        emit_progress(app, percent, detail);
    })?;

    emit_status(
        app,
        "running",
        "collect",
        "Writing subtitles and transcript",
        None,
    );
    for extension in formats {
        let produced = work_dir.join(format!("transcript.{extension}"));
        if !produced.is_file() {
            return Err(format!("Whisper did not produce {}.", produced.display()));
        }
        let destination = output_dir.join(format!("{base_name}.{extension}"));
        fs::rename(&produced, &destination)
            .map_err(|error| format!("Could not save {}: {error}", destination.display()))?;
        emit_log(app, "stdout", format!("Saved {}", destination.display()));
    }
    Ok(())
}
