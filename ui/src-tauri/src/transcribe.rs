//! Transcription workflow: extract audio, run MLX Whisper, and write
//! subtitles (.srt/.vtt) plus a raw transcript (.txt) beside the source.

use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::AppHandle;

use crate::events::{emit_log, emit_progress, emit_status};
use crate::media::{Ffmpeg, MediaProbe};
use crate::process::{format_clock, run_logged_command_observed, ConversionState};
use crate::runtime::{prepend_runtime_path, processor_paths, ProcessorPaths};

const WHISPER_MODEL: &str = "mlx-community/whisper-small-mlx";
const SUPPORTED_FORMATS: [&str; 5] = ["srt", "vtt", "txt", "tsv", "json"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscribeOptions {
    pub(crate) video_path: String,
    pub(crate) language: String,
    pub(crate) formats: Vec<String>,
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

    let result = run_transcribe_steps(
        app,
        state,
        &paths,
        &video_path,
        &work_dir,
        &output_dir,
        base_name,
        &options.language,
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
        .args(["--model", WHISPER_MODEL])
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
