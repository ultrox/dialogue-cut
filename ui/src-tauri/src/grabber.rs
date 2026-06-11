//! Material-grabber workflow: yt-dlp metadata probing and downloads.

use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    process::Command,
};
use tauri::AppHandle;

use crate::events::emit_status;
use crate::process::{run_captured_command, run_logged_command, ConversionState};
use crate::runtime::{
    dirs_home, ensure_private_download_tools, find_on_path, media_paths, prepend_media_path,
    prepend_runtime_path, ProcessorPaths,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrabOptions {
    pub(crate) url: String,
    pub(crate) output_dir: String,
    pub(crate) download_video: bool,
    pub(crate) download_subtitles: bool,
    pub(crate) quality: String,
    pub(crate) subtitle_languages: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrabProbeOptions {
    pub(crate) url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrabQuality {
    value: String,
    label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrabSubtitleTrack {
    language: String,
    label: String,
    has_manual: bool,
    has_automatic: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrabMetadata {
    title: String,
    webpage_url: String,
    extractor: String,
    duration: Option<f64>,
    qualities: Vec<GrabQuality>,
    subtitles: Vec<GrabSubtitleTrack>,
}

fn output_template_for_grab(output_dir: &Path) -> PathBuf {
    output_dir.join("%(title).200B [%(id)s].%(ext)s")
}

pub(crate) fn default_grab_output_dir() -> PathBuf {
    dirs_home().join("Downloads").join("Dialogue Cut Material")
}

pub(crate) fn subtitle_language_spec(raw: &str) -> String {
    raw.split(',')
        .map(str::trim)
        .filter(|language| !language.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

fn format_selector_for_quality(raw: &str) -> String {
    let quality = raw.trim();
    if quality == "best" {
        return "bv*+ba/b".into();
    }

    let max_height = quality.parse::<u32>().unwrap_or(1080);
    format!("bv*[height<={max_height}]+ba/b[height<={max_height}]/b")
}

fn string_field(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn collect_qualities(value: &serde_json::Value) -> Vec<GrabQuality> {
    let mut heights = BTreeSet::new();
    if let Some(formats) = value.get("formats").and_then(serde_json::Value::as_array) {
        for format in formats {
            let has_video = format
                .get("vcodec")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|codec| codec != "none");
            if !has_video {
                continue;
            }
            if let Some(height) = format.get("height").and_then(serde_json::Value::as_u64) {
                if (144..=4320).contains(&height) {
                    heights.insert(height);
                }
            }
        }
    }

    let mut qualities = vec![GrabQuality {
        value: "best".into(),
        label: "Best available".into(),
    }];
    qualities.extend(heights.iter().rev().map(|height| GrabQuality {
        value: height.to_string(),
        label: format!("{height}p or lower"),
    }));
    qualities
}

fn collect_subtitle_group(
    value: &serde_json::Value,
    key: &str,
    label: &str,
    tracks: &mut BTreeMap<String, BTreeSet<String>>,
) {
    let Some(group) = value.get(key).and_then(serde_json::Value::as_object) else {
        return;
    };
    for language in group.keys() {
        if language == "live_chat" || language.starts_with("live_chat") {
            continue;
        }
        tracks
            .entry(language.to_string())
            .or_default()
            .insert(label.into());
    }
}

fn collect_subtitles(value: &serde_json::Value) -> Vec<GrabSubtitleTrack> {
    let mut tracks = BTreeMap::new();
    collect_subtitle_group(value, "subtitles", "manual", &mut tracks);
    collect_subtitle_group(value, "automatic_captions", "auto", &mut tracks);

    let mut subtitles = tracks
        .into_iter()
        .map(|(language, sources)| {
            let has_manual = sources.contains("manual");
            let has_automatic = sources.contains("auto");
            let source_label = match (has_manual, has_automatic) {
                (true, true) => "manual + auto",
                (true, false) => "manual",
                (false, true) => "auto",
                (false, false) => "unknown",
            };
            GrabSubtitleTrack {
                label: format!("{language} ({source_label})"),
                language,
                has_manual,
                has_automatic,
            }
        })
        .collect::<Vec<_>>();

    subtitles.sort_by_key(|track| {
        let priority = match track.language.as_str() {
            "de" => 0,
            "en" => 1,
            _ => 2,
        };
        (priority, track.language.clone())
    });
    subtitles
}

fn parse_grab_metadata(stdout: &str) -> Result<GrabMetadata, String> {
    let value: serde_json::Value = serde_json::from_str(stdout)
        .map_err(|error| format!("Could not parse yt-dlp metadata: {error}"))?;
    let title = string_field(&value, "title");
    Ok(GrabMetadata {
        title: if title.is_empty() {
            "Untitled video".into()
        } else {
            title
        },
        webpage_url: string_field(&value, "webpage_url"),
        extractor: string_field(&value, "extractor"),
        duration: value.get("duration").and_then(serde_json::Value::as_f64),
        qualities: collect_qualities(&value),
        subtitles: collect_subtitles(&value),
    })
}

enum DownloadRunner {
    Binary {
        binary: PathBuf,
        paths: ProcessorPaths,
    },
    PythonModule {
        paths: ProcessorPaths,
    },
}

fn download_runner(app: &AppHandle, state: &ConversionState) -> Result<DownloadRunner, String> {
    if cfg!(debug_assertions) {
        if let Some(binary) = find_on_path("yt-dlp") {
            return Ok(DownloadRunner::Binary {
                binary,
                paths: media_paths(app, state)?,
            });
        }
    }

    Ok(DownloadRunner::PythonModule {
        paths: ensure_private_download_tools(app, state)?,
    })
}

fn add_probe_args(command: &mut Command, url: &str) {
    command
        .args([
            "--ignore-config",
            "--no-playlist",
            "--skip-download",
            "--dump-single-json",
        ])
        .arg(url.trim());
}

fn add_grab_args(
    command: &mut Command,
    options: &GrabOptions,
    output_template: &Path,
    tools_dir: &Path,
) {
    command
        .args([
            "--ignore-config",
            "--newline",
            "--no-playlist",
            "--restrict-filenames",
            "--windows-filenames",
        ])
        .arg("--ffmpeg-location")
        .arg(tools_dir)
        .arg("-o")
        .arg(output_template);

    if options.download_video {
        let format_selector = format_selector_for_quality(&options.quality);
        command
            .args(["-f", &format_selector])
            .args(["-S", "res,vcodec:h264,acodec:m4a"])
            .args(["--merge-output-format", "mp4"])
            .args(["--remux-video", "mp4"]);
    } else {
        command.arg("--skip-download");
    }

    if options.download_subtitles {
        let languages = subtitle_language_spec(&options.subtitle_languages);
        command
            .arg("--write-subs")
            .arg("--write-auto-subs")
            .args(["--sub-langs", &languages])
            .args(["--sub-format", "srt/vtt/best"])
            .args(["--convert-subs", "srt"])
            .args(["--sleep-subtitles", "1"]);
    }

    command.arg(options.url.trim());
}

pub(crate) fn probe_grab_inner(
    app: &AppHandle,
    state: &ConversionState,
    options: &GrabProbeOptions,
) -> Result<GrabMetadata, String> {
    let runner = download_runner(app, state)?;
    emit_status(app, "running", "fetch", "Fetching material metadata", None);

    let stdout = match runner {
        DownloadRunner::Binary { binary, paths } => {
            let mut command = Command::new(binary);
            add_probe_args(&mut command, &options.url);
            prepend_media_path(&mut command, &paths);
            run_captured_command(app, state, &mut command)?
        }
        DownloadRunner::PythonModule { paths } => {
            let mut command = Command::new(&paths.python);
            command.args(["-m", "yt_dlp"]);
            add_probe_args(&mut command, &options.url);
            prepend_runtime_path(&mut command, &paths);
            run_captured_command(app, state, &mut command)?
        }
    };

    parse_grab_metadata(&stdout)
}

pub(crate) fn run_grab(
    app: &AppHandle,
    state: &ConversionState,
    options: &GrabOptions,
    output_dir: &Path,
) -> Result<(), String> {
    std::fs::create_dir_all(output_dir)
        .map_err(|error| format!("Could not create {}: {error}", output_dir.display()))?;
    let output_template = output_template_for_grab(output_dir);
    let runner = download_runner(app, state)?;

    let phase = if options.download_video {
        "download"
    } else {
        "subtitles"
    };
    let message = if options.download_video {
        "Downloading selected material"
    } else {
        "Saving selected subtitles"
    };
    emit_status(app, "running", phase, message, Some(output_dir));

    match runner {
        DownloadRunner::Binary { binary, paths } => {
            let mut command = Command::new(binary);
            add_grab_args(&mut command, options, &output_template, &paths.tools_dir);
            prepend_media_path(&mut command, &paths);
            run_logged_command(app, state, &mut command)
        }
        DownloadRunner::PythonModule { paths } => {
            let mut command = Command::new(&paths.python);
            command.args(["-m", "yt_dlp"]);
            add_grab_args(&mut command, options, &output_template, &paths.tools_dir);
            prepend_runtime_path(&mut command, &paths);
            run_logged_command(app, state, &mut command)
        }
    }
}
