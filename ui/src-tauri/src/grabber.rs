//! Material-grabber workflow: yt-dlp metadata probing and downloads.

use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
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
    pub(crate) download_json3_subtitles: bool,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrabTextFile {
    path: String,
    file_name: String,
    folder_name: String,
    size_bytes: Option<u64>,
    modified: Option<u64>,
}

const MAX_GRAB_TEXT_BYTES: u64 = 20 * 1024 * 1024;

fn output_template_for_grab(output_dir: &Path) -> PathBuf {
    output_dir
        .join("%(title).200B [%(id)s]")
        .join("%(title).200B [%(id)s].%(ext)s")
}

pub(crate) fn default_grab_output_dir() -> PathBuf {
    dirs_home().join("Downloads").join("Dialogue Cut Material")
}

const GRAB_OUTPUT_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "mov", "m4v", "webm", "srt", "json3", "vtt", "ttml", "srv1", "srv2", "srv3",
];

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileFingerprint {
    len: u64,
    modified: Option<SystemTime>,
}

fn is_grab_output_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| GRAB_OUTPUT_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_grab_text_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "srt" | "vtt" | "json3" | "json" | "ttml" | "srv1" | "srv2" | "srv3"
            )
        })
        .unwrap_or(false)
}

fn modified_seconds_from_metadata(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

fn collect_grab_text_files(directory: &Path, depth: u8, files: &mut Vec<GrabTextFile>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_file() && is_grab_text_file(&path) {
            let metadata = fs::metadata(&path).ok();
            files.push(GrabTextFile {
                file_name: path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("text")
                    .to_string(),
                folder_name: path
                    .parent()
                    .and_then(|parent| parent.file_name())
                    .and_then(|value| value.to_str())
                    .unwrap_or("")
                    .to_string(),
                path: path.display().to_string(),
                size_bytes: metadata.as_ref().map(fs::Metadata::len),
                modified: metadata.as_ref().and_then(modified_seconds_from_metadata),
            });
        } else if depth < 1 && path.is_dir() {
            collect_grab_text_files(&path, depth + 1, files);
        }
    }
}

pub(crate) fn list_grab_text_files_inner(
    directory: &Path,
    url: Option<&str>,
) -> Result<Vec<GrabTextFile>, String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create {}: {error}", directory.display()))?;

    let mut files = Vec::new();
    collect_grab_text_files(directory, 0, &mut files);
    if let Some(video_id) = url.and_then(youtube_video_id) {
        let video_id = video_id.to_ascii_lowercase();
        files.retain(|file| file.folder_name.to_ascii_lowercase().contains(&video_id));
    }
    files.sort_by_key(|file| std::cmp::Reverse(file.modified.unwrap_or(0)));
    files.truncate(80);
    Ok(files)
}

pub(crate) fn read_grab_text_file_inner(path: &Path) -> Result<String, String> {
    if !is_grab_text_file(path) {
        return Err("Choose a subtitle or caption text file.".into());
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    if metadata.len() > MAX_GRAB_TEXT_BYTES {
        return Err(format!("{} is too large to preview.", path.display()));
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

pub(crate) fn delete_grab_text_file_inner(path: &Path) -> Result<(), String> {
    if !is_grab_text_file(path) {
        return Err("Choose a subtitle or caption text file.".into());
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err("Choose a subtitle or caption text file.".into());
    }
    fs::remove_file(path).map_err(|error| format!("Could not delete {}: {error}", path.display()))
}

fn collect_grab_output_files(
    directory: &Path,
    depth: u8,
    files: &mut BTreeMap<PathBuf, FileFingerprint>,
) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };

    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.is_file() && is_grab_output_file(&path) {
            if let Ok(metadata) = fs::metadata(&path) {
                files.insert(
                    path,
                    FileFingerprint {
                        len: metadata.len(),
                        modified: metadata.modified().ok(),
                    },
                );
            }
        } else if depth < 1 && path.is_dir() {
            collect_grab_output_files(&path, depth + 1, files);
        }
    }
}

fn snapshot_grab_output_files(directory: &Path) -> BTreeMap<PathBuf, FileFingerprint> {
    let mut files = BTreeMap::new();
    collect_grab_output_files(directory, 0, &mut files);
    files
}

fn youtube_video_id(url: &str) -> Option<String> {
    let raw = url.trim();
    if let Some((_, rest)) = raw.split_once("youtu.be/") {
        return rest
            .split(['?', '&', '#', '/'])
            .next()
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
    }
    if let Some((_, rest)) = raw.split_once("/shorts/") {
        return rest
            .split(['?', '&', '#', '/'])
            .next()
            .filter(|value| !value.is_empty())
            .map(ToString::to_string);
    }
    raw.split_once("v=")
        .and_then(|(_, rest)| rest.split(['&', '#']).next())
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn output_file_exists_for_url(
    files: &BTreeMap<PathBuf, FileFingerprint>,
    url: &str,
    predicate: impl Fn(&str) -> bool,
) -> bool {
    let Some(video_id) = youtube_video_id(url) else {
        return false;
    };
    let video_id = video_id.to_ascii_lowercase();
    files.keys().any(|path| {
        let file_matches = path
            .file_name()
            .and_then(|file_name| file_name.to_str())
            .map(|file_name| file_name.to_ascii_lowercase())
            .is_some_and(|file_name| file_name.contains(&video_id) && predicate(&file_name));
        let folder_matches = path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|folder_name| folder_name.to_str())
            .map(|folder_name| folder_name.to_ascii_lowercase())
            .is_some_and(|folder_name| folder_name.contains(&video_id));
        file_matches && folder_matches
    })
}

fn requested_subtitle_file_exists(
    files: &BTreeMap<PathBuf, FileFingerprint>,
    url: &str,
    language: &str,
    extension: &str,
) -> bool {
    let language = language.to_ascii_lowercase();
    let extension = extension.to_ascii_lowercase();
    output_file_exists_for_url(files, url, |file_name| {
        file_name.ends_with(&format!(".{language}.{extension}"))
    })
}

fn requested_outputs_already_exist(
    files: &BTreeMap<PathBuf, FileFingerprint>,
    options: &GrabOptions,
) -> bool {
    if options.download_video
        && !output_file_exists_for_url(files, &options.url, |file_name| {
            [".mp4", ".mkv", ".mov", ".m4v", ".webm"]
                .iter()
                .any(|extension| file_name.ends_with(extension))
        })
    {
        return false;
    }

    let languages = subtitle_language_spec(&options.subtitle_languages);
    for language in languages.split(',').filter(|language| !language.is_empty()) {
        if options.download_subtitles
            && !requested_subtitle_file_exists(files, &options.url, language, "srt")
        {
            return false;
        }
        if options.download_json3_subtitles
            && !requested_subtitle_file_exists(files, &options.url, language, "json3")
        {
            return false;
        }
    }

    true
}

fn remove_empty_grab_folder_for_url(output_dir: &Path, url: &str) {
    let Some(video_id) = youtube_video_id(url) else {
        return;
    };
    let Ok(entries) = fs::read_dir(output_dir) else {
        return;
    };

    for path in entries.filter_map(Result::ok).map(|entry| entry.path()) {
        let name_matches = path
            .file_name()
            .and_then(|file_name| file_name.to_str())
            .is_some_and(|file_name| file_name.contains(&video_id));
        if path.is_dir()
            && name_matches
            && fs::read_dir(&path)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false)
        {
            let _ = fs::remove_dir(path);
        }
    }
}

fn verify_grab_created_output(
    output_dir: &Path,
    before: &BTreeMap<PathBuf, FileFingerprint>,
    options: &GrabOptions,
) -> Result<(), String> {
    let after = snapshot_grab_output_files(output_dir);
    let changed = after
        .iter()
        .any(|(path, fingerprint)| before.get(path) != Some(fingerprint));

    let valid_output_exists = if youtube_video_id(&options.url).is_some() {
        requested_outputs_already_exist(&after, options)
    } else {
        changed
    };

    if valid_output_exists {
        Ok(())
    } else {
        Err("yt-dlp finished but did not create the requested video or subtitle files.".into())
    }
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

fn caption_formats_include_source_track(formats: &serde_json::Value) -> bool {
    formats.as_array().is_some_and(|formats| {
        formats.iter().any(|format| {
            format
                .get("url")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|url| !url.contains("tlang="))
        })
    })
}

fn collect_subtitle_group(
    value: &serde_json::Value,
    key: &str,
    label: &str,
    only_source_tracks: bool,
    tracks: &mut BTreeMap<String, BTreeSet<String>>,
) {
    let Some(group) = value.get(key).and_then(serde_json::Value::as_object) else {
        return;
    };
    for (language, formats) in group {
        if language == "live_chat" || language.starts_with("live_chat") {
            continue;
        }
        if only_source_tracks && !caption_formats_include_source_track(formats) {
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
    collect_subtitle_group(value, "subtitles", "manual", false, &mut tracks);
    collect_subtitle_group(value, "automatic_captions", "auto", true, &mut tracks);

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
            language if language == "en" || language.starts_with("en-") => 1,
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

fn subtitle_download_message(options: &GrabOptions) -> &'static str {
    match (options.download_subtitles, options.download_json3_subtitles) {
        (true, true) => "Saving SRT and JSON3 subtitles",
        (true, false) => "Saving SRT subtitles",
        (false, true) => "Saving JSON3 subtitles",
        (false, false) => "Saving selected subtitles",
    }
}

fn add_json3_subtitle_args(command: &mut Command, options: &GrabOptions, output_template: &Path) {
    let languages = subtitle_language_spec(&options.subtitle_languages);
    command
        .args([
            "--ignore-config",
            "--newline",
            "--no-playlist",
            "--restrict-filenames",
            "--windows-filenames",
            "--skip-download",
            "--write-subs",
            "--write-auto-subs",
        ])
        .arg("-o")
        .arg(output_template)
        .args(["--sub-langs", &languages])
        .args(["--sub-format", "json3"])
        .args(["--sleep-subtitles", "1"])
        .arg(options.url.trim());
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
    fs::create_dir_all(output_dir)
        .map_err(|error| format!("Could not create {}: {error}", output_dir.display()))?;
    remove_empty_grab_folder_for_url(output_dir, &options.url);
    let before_outputs = snapshot_grab_output_files(output_dir);
    let output_template = output_template_for_grab(output_dir);
    let runner = download_runner(app, state)?;
    let needs_primary_download = options.download_video || options.download_subtitles;

    let (phase, message) = if options.download_video {
        let message = if options.download_subtitles || options.download_json3_subtitles {
            "Downloading video and subtitles"
        } else {
            "Downloading selected material"
        };
        ("download", message)
    } else {
        ("subtitles", subtitle_download_message(options))
    };
    emit_status(app, "running", phase, message, Some(output_dir));

    let result: Result<(), String> = match runner {
        DownloadRunner::Binary { binary, paths } => {
            if needs_primary_download {
                let mut command = Command::new(&binary);
                add_grab_args(&mut command, options, &output_template, &paths.tools_dir);
                prepend_media_path(&mut command, &paths);
                run_logged_command(app, state, &mut command)?;
            }

            if options.download_json3_subtitles {
                emit_status(
                    app,
                    "running",
                    "subtitles",
                    subtitle_download_message(options),
                    Some(output_dir),
                );
                let mut command = Command::new(binary);
                add_json3_subtitle_args(&mut command, options, &output_template);
                prepend_media_path(&mut command, &paths);
                run_logged_command(app, state, &mut command)?;
            }

            Ok(())
        }
        DownloadRunner::PythonModule { paths } => {
            if needs_primary_download {
                let mut command = Command::new(&paths.python);
                command.args(["-m", "yt_dlp"]);
                add_grab_args(&mut command, options, &output_template, &paths.tools_dir);
                prepend_runtime_path(&mut command, &paths);
                run_logged_command(app, state, &mut command)?;
            }

            if options.download_json3_subtitles {
                emit_status(
                    app,
                    "running",
                    "subtitles",
                    subtitle_download_message(options),
                    Some(output_dir),
                );
                let mut command = Command::new(&paths.python);
                command.args(["-m", "yt_dlp"]);
                add_json3_subtitle_args(&mut command, options, &output_template);
                prepend_runtime_path(&mut command, &paths);
                run_logged_command(app, state, &mut command)?;
            }

            Ok(())
        }
    };

    result?;
    remove_empty_grab_folder_for_url(output_dir, &options.url);
    verify_grab_created_output(output_dir, &before_outputs, options)
}
