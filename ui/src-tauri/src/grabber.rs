//! Material-grabber workflow: yt-dlp metadata probing and downloads.

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::AppHandle;

use crate::events::{emit_log, emit_status};
use crate::process::{run_captured_command, run_logged_command, ConversionState};
use crate::runtime::{
    dirs_home, ensure_private_download_tools, prepend_runtime_path, ProcessorPaths,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrabOptions {
    pub(crate) url: String,
    pub(crate) output_dir: String,
    pub(crate) video: bool,
    pub(crate) quality: String,
    pub(crate) audio: bool,
    pub(crate) audio_langs: Vec<String>,
    pub(crate) mux: String,
    pub(crate) subs: bool,
    pub(crate) manual_langs: Vec<String>,
    pub(crate) auto_langs: Vec<String>,
    pub(crate) subtitle_formats: Vec<String>,
    pub(crate) chapters: bool,
    pub(crate) chapter_formats: Vec<String>,
}

impl GrabOptions {
    fn wants_muxed(&self) -> bool {
        self.mux != "separate"
    }

    fn wants_silent_video(&self) -> bool {
        self.video && (!self.audio || self.audio_langs.is_empty() || !self.wants_muxed())
    }

    fn wants_muxed_video(&self) -> bool {
        self.video && self.audio && !self.audio_langs.is_empty() && self.wants_muxed()
    }

    fn wants_separate_audio(&self) -> bool {
        self.audio && !self.audio_langs.is_empty() && (!self.video || !self.wants_muxed())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrabProbeOptions {
    pub(crate) url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrabQuality {
    height: u64,
    label: String,
    codec: String,
    size_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrabAudioTrack {
    /// yt-dlp `language` value; empty when the source does not label tracks.
    id: String,
    name: String,
    original: bool,
    size_bytes: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrabSubtitleTrack {
    id: String,
    language: String,
    name: String,
    auto: bool,
}

/// yt-dlp names these `start_time`/`end_time`; the frontend and the JSON file
/// we write both use the shorter `start`/`end`. The two directions therefore
/// need different names — renaming both would hand the UI keys it never reads.
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct GrabChapter {
    #[serde(
        rename(serialize = "start", deserialize = "start_time"),
        alias = "start"
    )]
    start: f64,
    #[serde(rename(serialize = "end", deserialize = "end_time"), alias = "end")]
    end: f64,
    #[serde(default)]
    title: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GrabMetadata {
    title: String,
    webpage_url: String,
    extractor: String,
    duration: Option<f64>,
    thumbnail: String,
    qualities: Vec<GrabQuality>,
    audio_tracks: Vec<GrabAudioTrack>,
    subtitles: Vec<GrabSubtitleTrack>,
    chapters: Vec<GrabChapter>,
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

fn grab_folder_template(output_dir: &Path) -> PathBuf {
    output_dir.join("%(title).200B [%(id)s]")
}

pub(crate) fn default_grab_output_dir() -> PathBuf {
    dirs_home().join("Downloads").join("Dialogue Cut Material")
}

const GRAB_OUTPUT_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "mov", "m4v", "m4a", "webm", "srt", "json3", "json", "txt", "vtt", "ttml",
    "srv1", "srv2", "srv3",
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
                "srt" | "vtt" | "json3" | "json" | "txt" | "ttml" | "srv1" | "srv2" | "srv3"
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

/// One expected output file, matched against lowercase file names.
enum ExpectedOutput {
    /// `<base>.<height>p.<lang>.mp4` — muxed video, or `<base>.<height>p.mp4`
    /// when the source has no labelled audio languages (empty lang).
    MuxedVideo(String),
    /// `<base>.<height>p.video.mp4`
    SilentVideo,
    /// `<base>.<lang>.m4a` (or `<base>.audio.m4a` for empty lang)
    AudioFile(String),
    /// `<base>.<lang>.<fmt>` not carrying the `.auto.` marker
    ManualSubtitle(String, String),
    /// `<base>.auto.<lang>.<fmt>`
    AutoSubtitle(String, String),
    /// `<base>.chapters.<fmt>`
    ChapterFile(String),
}

fn ends_with_height_marker(name: &str, suffix: &str) -> bool {
    let Some(stem) = name.strip_suffix(suffix) else {
        return false;
    };
    let Some(stem) = stem.strip_suffix('p') else {
        return false;
    };
    let digits = stem.chars().rev().take_while(char::is_ascii_digit).count();
    digits > 0 && stem[..stem.len() - digits].ends_with('.')
}

impl ExpectedOutput {
    fn matches(&self, file_name: &str) -> bool {
        match self {
            Self::MuxedVideo(lang) if lang.is_empty() => ends_with_height_marker(file_name, ".mp4"),
            Self::MuxedVideo(lang) => ends_with_height_marker(file_name, &format!(".{lang}.mp4")),
            Self::SilentVideo => ends_with_height_marker(file_name, ".video.mp4"),
            Self::AudioFile(lang) if lang.is_empty() => file_name.ends_with(".audio.m4a"),
            Self::AudioFile(lang) => file_name.ends_with(&format!(".{lang}.m4a")),
            Self::ManualSubtitle(lang, format) => {
                file_name.ends_with(&format!(".{lang}.{format}")) && !file_name.contains(".auto.")
            }
            Self::AutoSubtitle(lang, format) => {
                file_name.ends_with(&format!(".auto.{lang}.{format}"))
            }
            Self::ChapterFile(format) => file_name.ends_with(&format!(".chapters.{format}")),
        }
    }
}

fn expected_outputs(options: &GrabOptions) -> Vec<ExpectedOutput> {
    let mut expected = Vec::new();
    if options.wants_muxed_video() {
        for lang in &options.audio_langs {
            expected.push(ExpectedOutput::MuxedVideo(lang.to_ascii_lowercase()));
        }
    }
    if options.wants_silent_video() {
        expected.push(ExpectedOutput::SilentVideo);
    }
    if options.wants_separate_audio() {
        for lang in &options.audio_langs {
            expected.push(ExpectedOutput::AudioFile(lang.to_ascii_lowercase()));
        }
    }
    if options.subs {
        for format in &options.subtitle_formats {
            let format = format.to_ascii_lowercase();
            for lang in &options.manual_langs {
                expected.push(ExpectedOutput::ManualSubtitle(
                    lang.to_ascii_lowercase(),
                    format.clone(),
                ));
            }
            for lang in &options.auto_langs {
                expected.push(ExpectedOutput::AutoSubtitle(
                    lang.to_ascii_lowercase(),
                    format.clone(),
                ));
            }
        }
    }
    if options.chapters {
        for format in &options.chapter_formats {
            expected.push(ExpectedOutput::ChapterFile(format.to_ascii_lowercase()));
        }
    }
    expected
}

fn requested_outputs_already_exist(
    files: &BTreeMap<PathBuf, FileFingerprint>,
    options: &GrabOptions,
) -> bool {
    let Some(video_id) = youtube_video_id(&options.url) else {
        return false;
    };
    let video_id = video_id.to_ascii_lowercase();

    expected_outputs(options).iter().all(|expected| {
        files.keys().any(|path| {
            let folder_matches = path
                .parent()
                .and_then(|parent| parent.file_name())
                .and_then(|folder_name| folder_name.to_str())
                .map(|folder_name| folder_name.to_ascii_lowercase())
                .is_some_and(|folder_name| folder_name.contains(&video_id));
            let file_matches = path
                .file_name()
                .and_then(|file_name| file_name.to_str())
                .map(|file_name| file_name.to_ascii_lowercase())
                .is_some_and(|file_name| expected.matches(&file_name));
            folder_matches && file_matches
        })
    })
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
        Err(
            "yt-dlp finished but did not create the requested video, audio, or subtitle files."
                .into(),
        )
    }
}

// ---------- probe parsing ----------

fn string_field(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn format_size_estimate(format: &serde_json::Value, duration: Option<f64>) -> Option<u64> {
    format
        .get("filesize")
        .and_then(serde_json::Value::as_u64)
        .or_else(|| {
            format
                .get("filesize_approx")
                .and_then(serde_json::Value::as_u64)
        })
        .or_else(|| {
            let bitrate = format.get("tbr").and_then(serde_json::Value::as_f64)?;
            let duration = duration?;
            Some((bitrate * duration * 125.0) as u64)
        })
}

fn codec_family(vcodec: &str) -> (&'static str, u8) {
    let codec = vcodec.to_ascii_lowercase();
    if codec.starts_with("avc") || codec.starts_with("h264") {
        ("H.264", 0)
    } else if codec.starts_with("vp9") || codec.starts_with("vp09") {
        ("VP9", 1)
    } else if codec.starts_with("av01") {
        ("AV1", 2)
    } else if codec.starts_with("hev") || codec.starts_with("hvc") || codec.starts_with("h265") {
        ("H.265", 3)
    } else {
        ("", 4)
    }
}

fn collect_video_qualities(value: &serde_json::Value, duration: Option<f64>) -> Vec<GrabQuality> {
    // Per height keep the codec the downloader's sort would pick
    // (`-S vcodec:h264` — H.264 first) and that codec's best size estimate.
    let mut by_height: BTreeMap<u64, (u8, &'static str, Option<u64>)> = BTreeMap::new();
    let Some(formats) = value.get("formats").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };

    for format in formats {
        let vcodec = format
            .get("vcodec")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("none");
        if vcodec == "none" {
            continue;
        }
        let Some(height) = format.get("height").and_then(serde_json::Value::as_u64) else {
            continue;
        };
        if !(144..=4320).contains(&height) {
            continue;
        }
        let (label, rank) = codec_family(vcodec);
        let size = format_size_estimate(format, duration);
        by_height
            .entry(height)
            .and_modify(|entry| {
                if rank < entry.0 {
                    *entry = (rank, label, size);
                } else if rank == entry.0 {
                    entry.2 = match (entry.2, size) {
                        (Some(a), Some(b)) => Some(a.max(b)),
                        (a, b) => a.or(b),
                    };
                }
            })
            .or_insert((rank, label, size));
    }

    by_height
        .into_iter()
        .rev()
        .map(|(height, (_, codec, size_bytes))| GrabQuality {
            label: format!("{height}p"),
            height,
            codec: codec.to_string(),
            size_bytes,
        })
        .collect()
}

/// Turn a yt-dlp audio `format_note` such as
/// "English (US) original (default), medium" into a display name.
fn audio_display_name(format_note: &str, language: &str) -> String {
    let mut name = format_note.split(',').next().unwrap_or("").to_string();
    for marker in [
        "original (default)",
        "(default)",
        "original",
        "dubbed-auto",
        "dubbed (auto)",
        "auto-dubbed",
        "dubbed",
        "descriptive",
        "secondary",
    ] {
        if let Some(index) = name.to_ascii_lowercase().find(marker) {
            name.replace_range(index..index + marker.len(), "");
        }
    }
    let name = name.trim().trim_matches(['-', ','].as_slice()).trim();
    if name.is_empty()
        || matches!(
            name.to_ascii_lowercase().as_str(),
            "low" | "medium" | "high" | "ultralow"
        )
    {
        if language.is_empty() {
            "Original audio".into()
        } else {
            language.into()
        }
    } else {
        name.to_string()
    }
}

fn collect_audio_tracks(value: &serde_json::Value, duration: Option<f64>) -> Vec<GrabAudioTrack> {
    struct AudioAggregate {
        name: String,
        original: bool,
        size_bytes: Option<u64>,
        prefers_m4a: bool,
    }

    let mut by_language: BTreeMap<String, AudioAggregate> = BTreeMap::new();
    let Some(formats) = value.get("formats").and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };

    for format in formats {
        let acodec = format
            .get("acodec")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("none");
        let vcodec = format
            .get("vcodec")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("none");
        if acodec == "none" || vcodec != "none" {
            continue;
        }

        let language = string_field(format, "language");
        let note = string_field(format, "format_note");
        let original = format
            .get("language_preference")
            .and_then(serde_json::Value::as_i64)
            .is_some_and(|preference| preference > 0)
            || note.to_ascii_lowercase().contains("original")
            || note.to_ascii_lowercase().contains("(default)");
        let is_m4a = format
            .get("ext")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|ext| ext == "m4a");
        let size = format_size_estimate(format, duration);

        let entry = by_language
            .entry(language.clone())
            .or_insert_with(|| AudioAggregate {
                name: audio_display_name(&note, &language),
                original: false,
                size_bytes: None,
                prefers_m4a: false,
            });
        entry.original |= original;
        // Report the size of the best track in the container we download (m4a).
        if is_m4a && !entry.prefers_m4a {
            entry.prefers_m4a = true;
            entry.size_bytes = size;
        } else if is_m4a == entry.prefers_m4a {
            entry.size_bytes = match (entry.size_bytes, size) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
        }
    }

    let mut tracks = by_language
        .into_iter()
        .map(|(language, aggregate)| GrabAudioTrack {
            id: language,
            name: aggregate.name,
            original: aggregate.original,
            size_bytes: aggregate.size_bytes,
        })
        .collect::<Vec<_>>();
    tracks.sort_by(|a, b| {
        b.original
            .cmp(&a.original)
            .then_with(|| a.name.cmp(&b.name))
    });
    tracks
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

fn subtitle_display_name(formats: &serde_json::Value, language: &str) -> String {
    formats
        .as_array()
        .and_then(|formats| {
            formats.iter().find_map(|format| {
                format
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .filter(|name| !name.is_empty())
                    .map(ToString::to_string)
            })
        })
        .unwrap_or_else(|| language.to_string())
}

fn collect_subtitle_group(
    value: &serde_json::Value,
    key: &str,
    auto: bool,
    only_source_tracks: bool,
    tracks: &mut Vec<GrabSubtitleTrack>,
) {
    let Some(group) = value.get(key).and_then(serde_json::Value::as_object) else {
        return;
    };
    for (language, formats) in group {
        if language.starts_with("live_chat") {
            continue;
        }
        if only_source_tracks && !caption_formats_include_source_track(formats) {
            continue;
        }
        tracks.push(GrabSubtitleTrack {
            id: if auto {
                format!("{language}.auto")
            } else {
                language.clone()
            },
            language: language.clone(),
            name: subtitle_display_name(formats, language),
            auto,
        });
    }
}

fn collect_subtitles(value: &serde_json::Value) -> Vec<GrabSubtitleTrack> {
    let mut tracks = Vec::new();
    collect_subtitle_group(value, "subtitles", false, false, &mut tracks);
    // Auto captions are limited to source tracks; machine translations
    // (tlang= URLs) would flood the list with 150+ low-value entries.
    collect_subtitle_group(value, "automatic_captions", true, true, &mut tracks);

    tracks.sort_by(|a, b| {
        let priority = |track: &GrabSubtitleTrack| match track.language.as_str() {
            "de" => 0,
            language if language == "en" || language.starts_with("en-") => 1,
            _ => 2,
        };
        priority(a)
            .cmp(&priority(b))
            .then_with(|| a.language.cmp(&b.language))
            .then_with(|| a.auto.cmp(&b.auto))
    });
    tracks
}

fn collect_chapters(value: &serde_json::Value) -> Vec<GrabChapter> {
    value
        .get("chapters")
        .and_then(serde_json::Value::as_array)
        .map(|chapters| {
            chapters
                .iter()
                .filter_map(|chapter| serde_json::from_value(chapter.clone()).ok())
                .collect()
        })
        .unwrap_or_default()
}

/// `3725.4` -> `1:02:05`, the shape people write in a description.
fn short_timestamp(seconds: f64) -> String {
    let total = seconds.max(0.0);
    let hours = (total / 3600.0).floor() as u64;
    let minutes = ((total % 3600.0) / 60.0).floor() as u64;
    let secs = (total % 60.0).floor() as u64;
    if hours > 0 {
        format!("{hours}:{minutes:02}:{secs:02}")
    } else {
        format!("{minutes}:{secs:02}")
    }
}

pub(crate) fn render_chapters(chapters: &[GrabChapter], format: &str) -> String {
    match format {
        // The shape the uploader wrote in the description.
        "txt" => chapters
            .iter()
            .map(|chapter| format!("{} {}", short_timestamp(chapter.start), chapter.title))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => serde_json::to_string_pretty(chapters).unwrap_or_else(|_| "[]".into()),
    }
}

fn parse_grab_metadata(stdout: &str) -> Result<GrabMetadata, String> {
    let value: serde_json::Value = serde_json::from_str(stdout)
        .map_err(|error| format!("Could not parse yt-dlp metadata: {error}"))?;
    let title = string_field(&value, "title");
    let duration = value.get("duration").and_then(serde_json::Value::as_f64);
    Ok(GrabMetadata {
        title: if title.is_empty() {
            "Untitled video".into()
        } else {
            title
        },
        webpage_url: string_field(&value, "webpage_url"),
        extractor: string_field(&value, "extractor"),
        thumbnail: string_field(&value, "thumbnail"),
        duration,
        qualities: collect_video_qualities(&value, duration),
        audio_tracks: collect_audio_tracks(&value, duration),
        subtitles: collect_subtitles(&value),
        chapters: collect_chapters(&value),
    })
}

// ---------- download jobs ----------

struct GrabJob {
    phase: &'static str,
    message: String,
    file_template: String,
    args: Vec<OsString>,
}

fn push_args(args: &mut Vec<OsString>, values: &[&str]) {
    args.extend(values.iter().map(OsString::from));
}

fn height_limit(quality: &str) -> Option<u32> {
    quality.trim().parse::<u32>().ok()
}

fn video_selector(quality: &str) -> (String, String, String) {
    match height_limit(quality) {
        Some(height) => (
            format!("bv*[height<={height}]"),
            format!("b[height<={height}]"),
            format!("{height}p"),
        ),
        None => ("bv*".into(), "b".into(), "best".into()),
    }
}

fn muxed_video_job(quality: &str, lang: &str) -> GrabJob {
    let (best_video, best_combined, quality_label) = video_selector(quality);
    let (selector, template, message) = if lang.is_empty() {
        (
            format!("{best_video}+ba/{best_combined}/b"),
            "%(title).200B [%(id)s].%(height)sp.%(ext)s".to_string(),
            format!("Downloading {quality_label} video with audio"),
        )
    } else {
        (
            format!("{best_video}+ba[language={lang}]/{best_video}+ba/{best_combined}/b"),
            format!("%(title).200B [%(id)s].%(height)sp.{lang}.%(ext)s"),
            format!("Downloading {quality_label} video with {lang} audio"),
        )
    };
    let mut args = Vec::new();
    push_args(
        &mut args,
        &[
            "-f",
            &selector,
            "-S",
            "res,vcodec:h264,acodec:m4a",
            "--merge-output-format",
            "mp4",
            "--remux-video",
            "mp4",
        ],
    );
    GrabJob {
        phase: "download",
        message,
        file_template: template,
        args,
    }
}

fn silent_video_job(quality: &str) -> GrabJob {
    let (best_video, best_combined, quality_label) = video_selector(quality);
    let selector = format!("{best_video}/bv*/{best_combined}/b");
    let mut args = Vec::new();
    push_args(
        &mut args,
        &[
            "-f",
            &selector,
            "-S",
            "res,vcodec:h264",
            "--remux-video",
            "mp4",
        ],
    );
    GrabJob {
        phase: "download",
        message: format!("Downloading {quality_label} video track"),
        file_template: "%(title).200B [%(id)s].%(height)sp.video.%(ext)s".into(),
        args,
    }
}

fn audio_job(lang: &str) -> GrabJob {
    let (selector, template, message) = if lang.is_empty() {
        (
            "ba[ext=m4a]/ba".to_string(),
            "%(title).200B [%(id)s].audio.%(ext)s".to_string(),
            "Downloading audio track".to_string(),
        )
    } else {
        (
            format!("ba[language={lang}][ext=m4a]/ba[language={lang}]/ba[ext=m4a]/ba"),
            format!("%(title).200B [%(id)s].{lang}.%(ext)s"),
            format!("Downloading {lang} audio"),
        )
    };
    let mut args = Vec::new();
    push_args(
        &mut args,
        &[
            "-f",
            &selector,
            "-S",
            "acodec:m4a",
            "--extract-audio",
            "--audio-format",
            "m4a",
        ],
    );
    GrabJob {
        phase: "download",
        message,
        file_template: template,
        args,
    }
}

fn subtitle_job(auto: bool, format: &str, languages: &[String]) -> GrabJob {
    let mut args = Vec::new();
    push_args(&mut args, &["--skip-download"]);
    push_args(
        &mut args,
        &[if auto {
            "--write-auto-subs"
        } else {
            "--write-subs"
        }],
    );
    push_args(&mut args, &["--sub-langs", &languages.join(",")]);
    match format {
        "vtt" => push_args(
            &mut args,
            &["--sub-format", "vtt/best", "--convert-subs", "vtt"],
        ),
        "json3" => push_args(&mut args, &["--sub-format", "json3"]),
        _ => push_args(
            &mut args,
            &["--sub-format", "srt/vtt/best", "--convert-subs", "srt"],
        ),
    }
    push_args(&mut args, &["--sleep-subtitles", "1"]);
    GrabJob {
        phase: "subtitles",
        message: format!(
            "Saving {} {} subtitles",
            if auto { "auto" } else { "manual" },
            format.to_ascii_uppercase()
        ),
        // The `.auto` marker keeps auto captions from overwriting manual
        // ones — yt-dlp appends `.<lang>.<ext>` to this template itself.
        file_template: if auto {
            "%(title).200B [%(id)s].auto.%(ext)s".into()
        } else {
            "%(title).200B [%(id)s].%(ext)s".into()
        },
        args,
    }
}

fn grab_jobs(options: &GrabOptions) -> Vec<GrabJob> {
    let mut jobs = Vec::new();
    if options.wants_muxed_video() {
        for lang in &options.audio_langs {
            jobs.push(muxed_video_job(&options.quality, lang));
        }
    }
    if options.wants_silent_video() {
        jobs.push(silent_video_job(&options.quality));
    }
    if options.wants_separate_audio() {
        for lang in &options.audio_langs {
            jobs.push(audio_job(lang));
        }
    }
    if options.subs {
        for format in &options.subtitle_formats {
            if !options.manual_langs.is_empty() {
                jobs.push(subtitle_job(false, format, &options.manual_langs));
            }
            if !options.auto_langs.is_empty() {
                jobs.push(subtitle_job(true, format, &options.auto_langs));
            }
        }
    }
    jobs
}

struct DownloadRunner {
    paths: ProcessorPaths,
}

impl DownloadRunner {
    fn paths(&self) -> &ProcessorPaths {
        &self.paths
    }

    fn command(&self) -> Command {
        let mut command = Command::new(&self.paths.python);
        let deno = self.paths.venv_dir.join("bin/deno");
        let provider = format!(
            "youtubepot-bgutilscript:server_home={}",
            self.paths.yt_dlp_pot_server.display()
        );
        command
            .args(["-m", "yt_dlp", "--js-runtimes"])
            .arg(format!("deno:{}", deno.display()))
            .args(["--extractor-args", &provider]);
        prepend_runtime_path(&mut command, &self.paths);
        command
    }
}

fn download_runner(app: &AppHandle, state: &ConversionState) -> Result<DownloadRunner, String> {
    Ok(DownloadRunner {
        paths: ensure_private_download_tools(app, state)?,
    })
}

/// The mweb client works with the managed PO-token provider; the embedded
/// client also exposes dubbed audio and subtitle tracks. Probing and downloading
/// must use the same pair or a `ba[language=…]` selector could resolve against
/// tracks that the download invocation never sees.
const YOUTUBE_AUDIO_CLIENTS: &str = "youtube:player_client=mweb,web_embedded";

fn add_shared_grab_args(command: &mut Command) {
    command
        .args(["--ignore-config", "--no-playlist"])
        .args(["--extractor-args", YOUTUBE_AUDIO_CLIENTS]);
}

fn add_probe_args(command: &mut Command, url: &str) {
    add_shared_grab_args(command);
    command
        .args(["--skip-download", "--dump-single-json"])
        .arg(url.trim());
}

fn add_grab_job_args(
    command: &mut Command,
    job: &GrabJob,
    options: &GrabOptions,
    output_dir: &Path,
    tools_dir: &Path,
) {
    let output_template = grab_folder_template(output_dir).join(&job.file_template);
    add_shared_grab_args(command);
    command
        .args(["--newline", "--restrict-filenames", "--windows-filenames"])
        .arg("--ffmpeg-location")
        .arg(tools_dir)
        .arg("-o")
        .arg(output_template)
        .args(job.args.iter().map(OsString::as_os_str))
        .arg(options.url.trim());
}

fn is_http_403(error: &str) -> bool {
    error.contains("HTTP Error 403") || error.contains("HTTP 403")
}

fn run_grab_job(
    app: &AppHandle,
    state: &ConversionState,
    runner: &DownloadRunner,
    job: &GrabJob,
    options: &GrabOptions,
    output_dir: &Path,
) -> Result<(), String> {
    let mut command = runner.command();
    add_grab_job_args(
        &mut command,
        job,
        options,
        output_dir,
        &runner.paths().tools_dir,
    );
    let Err(error) = run_logged_command(app, state, &mut command) else {
        return Ok(());
    };
    if !is_http_403(&error) {
        return Err(error);
    }

    emit_log(
        app,
        "stderr",
        "YouTube rejected a media chunk (HTTP 403). Refreshing the signed URL and resuming...",
    );
    emit_status(
        app,
        "running",
        job.phase,
        "Refreshing the download link and resuming",
        Some(output_dir),
    );
    let mut retry = runner.command();
    add_grab_job_args(
        &mut retry,
        job,
        options,
        output_dir,
        &runner.paths().tools_dir,
    );
    run_logged_command(app, state, &mut retry)
}

pub(crate) fn probe_grab_inner(
    app: &AppHandle,
    state: &ConversionState,
    options: &GrabProbeOptions,
) -> Result<GrabMetadata, String> {
    let runner = download_runner(app, state)?;
    emit_status(app, "running", "fetch", "Fetching material metadata", None);

    let mut command = runner.command();
    add_probe_args(&mut command, &options.url);
    let stdout = run_captured_command(app, state, &mut command)?;

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
    let runner = download_runner(app, state)?;

    for job in grab_jobs(options) {
        emit_status(app, "running", job.phase, &job.message, Some(output_dir));
        run_grab_job(app, state, &runner, &job, options, output_dir)?;
    }

    if options.chapters {
        emit_status(
            app,
            "running",
            "chapters",
            "Saving chapters",
            Some(output_dir),
        );
        write_chapter_files(app, state, &runner, options, output_dir)?;
    }

    remove_empty_grab_folder_for_url(output_dir, &options.url);
    verify_grab_created_output(output_dir, &before_outputs, options)
}

/// Chapters are already parsed by yt-dlp but it has no "write chapters" flag,
/// so ask it for the resolved output path and the chapter list in one call and
/// serialise them here. Taking both from the same invocation keeps the file
/// names in step with whatever sanitising yt-dlp applied to the title.
fn write_chapter_files(
    app: &AppHandle,
    state: &ConversionState,
    runner: &DownloadRunner,
    options: &GrabOptions,
    output_dir: &Path,
) -> Result<(), String> {
    let output_template = grab_folder_template(output_dir).join("%(title).200B [%(id)s].%(ext)s");
    let mut command = runner.command();
    add_shared_grab_args(&mut command);
    command
        .args([
            "--skip-download",
            "--restrict-filenames",
            "--windows-filenames",
        ])
        .arg("-o")
        .arg(&output_template)
        .args(["--print", "filename"])
        .args(["--print", "%(chapters)j"])
        .arg(options.url.trim());
    let stdout = run_captured_command(app, state, &mut command)?;

    let mut lines = stdout.lines().filter(|line| !line.trim().is_empty());
    let resolved = lines
        .next()
        .ok_or("yt-dlp did not report where to write the chapters file.")?;
    let chapters_json = lines.next().unwrap_or("[]");
    let chapters: Vec<GrabChapter> =
        serde_json::from_str(chapters_json).unwrap_or_else(|_| Vec::new());
    if chapters.is_empty() {
        return Err("This video has no chapters to save.".into());
    }

    // `resolved` still carries yt-dlp's placeholder extension; the chapter
    // files sit beside it with their own suffixes.
    let base = Path::new(resolved).with_extension("");
    let folder = base
        .parent()
        .ok_or("Could not work out the chapters output folder.")?;
    fs::create_dir_all(folder)
        .map_err(|error| format!("Could not create {}: {error}", folder.display()))?;

    for format in &options.chapter_formats {
        let path = base.with_extension(format!("chapters.{format}"));
        fs::write(&path, render_chapters(&chapters, format))
            .map_err(|error| format!("Could not write {}: {error}", path.display()))?;
        emit_log(app, "stdout", &format!("Wrote {}", path.display()));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_http_403_errors_trigger_the_fresh_url_retry() {
        assert!(is_http_403(
            "unable to download video data: HTTP Error 403: Forbidden"
        ));
        assert!(!is_http_403("HTTP Error 429: Too Many Requests"));
        assert!(!is_http_403("Process exited with status 1"));
    }

    fn options(video: bool, audio: bool, subs: bool) -> GrabOptions {
        GrabOptions {
            url: "https://www.youtube.com/watch?v=0LmCveTM788".into(),
            output_dir: String::new(),
            video,
            quality: "1080".into(),
            audio,
            audio_langs: vec!["de".into(), "en".into()],
            mux: "single".into(),
            subs,
            manual_langs: vec!["de".into()],
            auto_langs: vec!["en".into()],
            subtitle_formats: vec!["srt".into()],
            chapters: false,
            chapter_formats: vec!["json".into()],
        }
    }

    /// The file names each job writes, with yt-dlp's own template fields
    /// resolved the way it would for a 1080p download.
    fn resolved_names(options: &GrabOptions) -> Vec<String> {
        grab_jobs(options)
            .iter()
            .map(|job| {
                job.file_template
                    .replace("%(title).200B [%(id)s]", "Clip [abc]")
                    .replace("%(height)s", "1080")
                    .replace(
                        "%(ext)s",
                        if job.phase == "subtitles" {
                            "de.srt"
                        } else {
                            "mp4"
                        },
                    )
            })
            .collect()
    }

    #[test]
    fn video_and_audio_muxed_gives_one_file_per_language() {
        let options = options(true, true, false);
        assert_eq!(
            resolved_names(&options),
            ["Clip [abc].1080p.de.mp4", "Clip [abc].1080p.en.mp4"]
        );
        assert!(options.wants_muxed_video() && !options.wants_silent_video());
    }

    #[test]
    fn video_and_audio_separate_gives_silent_video_plus_audio_per_language() {
        let mut options = options(true, true, false);
        options.mux = "separate".into();
        let names = resolved_names(&options);
        assert_eq!(names[0], "Clip [abc].1080p.video.mp4");
        assert_eq!(names.len(), 3, "silent video + one audio job per language");
        assert!(options.wants_separate_audio());
    }

    #[test]
    fn video_only_gives_a_silent_file() {
        let options = options(true, false, false);
        assert_eq!(resolved_names(&options), ["Clip [abc].1080p.video.mp4"]);
    }

    #[test]
    fn audio_only_gives_one_file_per_language() {
        let options = options(false, true, false);
        assert_eq!(grab_jobs(&options).len(), 2);
        assert!(!options.wants_silent_video() && !options.wants_muxed_video());
    }

    #[test]
    fn subtitles_split_manual_and_auto_per_format() {
        let mut options = options(false, false, true);
        options.subtitle_formats = vec!["srt".into(), "vtt".into()];
        // One job per (format x manual/auto); auto files carry the `.auto.` marker.
        let names = resolved_names(&options);
        assert_eq!(names.len(), 4);
        assert!(names.iter().filter(|name| name.contains(".auto.")).count() == 2);
    }

    #[test]
    fn expected_outputs_match_the_names_the_jobs_write() {
        for (video, audio, subs, mux) in [
            (true, true, true, "single"),
            (true, true, false, "separate"),
            (true, false, false, "single"),
            (false, true, false, "single"),
            (false, false, true, "single"),
        ] {
            let mut options = options(video, audio, subs);
            options.mux = mux.into();
            for expected in expected_outputs(&options) {
                let candidates = [
                    "clip [abc].1080p.de.mp4",
                    "clip [abc].1080p.en.mp4",
                    "clip [abc].1080p.video.mp4",
                    "clip [abc].de.m4a",
                    "clip [abc].en.m4a",
                    "clip [abc].de.srt",
                    "clip [abc].auto.en.srt",
                ];
                assert!(
                    candidates.iter().any(|name| expected.matches(name)),
                    "no produced file matches an expected output for {video}/{audio}/{subs}/{mux}"
                );
            }
        }
    }

    #[test]
    fn silent_and_muxed_video_names_do_not_cross_match() {
        assert!(!ExpectedOutput::SilentVideo.matches("clip [abc].1080p.de.mp4"));
        assert!(!ExpectedOutput::MuxedVideo(String::new()).matches("clip [abc].1080p.video.mp4"));
        assert!(ExpectedOutput::MuxedVideo("de".into()).matches("clip [abc].1080p.de.mp4"));
    }

    #[test]
    fn manual_subtitles_do_not_match_auto_files() {
        let manual = ExpectedOutput::ManualSubtitle("en".into(), "srt".into());
        assert!(manual.matches("clip [abc].en.srt"));
        assert!(!manual.matches("clip [abc].auto.en.srt"));
        assert!(ExpectedOutput::AutoSubtitle("en".into(), "srt".into())
            .matches("clip [abc].auto.en.srt"));
    }

    #[test]
    fn audio_display_name_strips_yt_dlp_qualifiers() {
        assert_eq!(
            audio_display_name("English (US) original (default), medium", "en-US"),
            "English (US)"
        );
        assert_eq!(audio_display_name("German dubbed, low", "de"), "German");
        assert_eq!(audio_display_name("medium", "fr"), "fr");
        assert_eq!(audio_display_name("", ""), "Original audio");
    }

    fn sample_chapters() -> Vec<GrabChapter> {
        vec![
            GrabChapter {
                start: 0.0,
                end: 31.0,
                title: "Introduction".into(),
            },
            GrabChapter {
                start: 31.0,
                end: 3725.4,
                title: "Deterrence".into(),
            },
        ]
    }

    #[test]
    fn chapters_render_as_description_style_text() {
        assert_eq!(
            render_chapters(&sample_chapters(), "txt"),
            "0:00 Introduction\n0:31 Deterrence"
        );
    }

    #[test]
    fn chapters_render_as_json_round_tripping_the_times() {
        let json = render_chapters(&sample_chapters(), "json");
        let parsed: Vec<GrabChapter> = serde_json::from_str(&json).expect("valid json");
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[1].start, 31.0);
        assert_eq!(parsed[1].title, "Deterrence");
    }

    /// The UI reads `chapter.start`. Serialising as yt-dlp's `start_time`
    /// instead left every row reading `undefined` and rendering as 0:00.
    #[test]
    fn chapters_reach_the_frontend_under_the_keys_it_reads() {
        let json = serde_json::to_string(&sample_chapters()).expect("serialises");
        assert!(json.contains(r#""start":31.0"#), "got {json}");
        assert!(json.contains(r#""end":3725.4"#), "got {json}");
        assert!(!json.contains("start_time"), "got {json}");
    }

    /// ...while the probe payload still arrives under yt-dlp's own names.
    #[test]
    fn chapters_deserialise_from_yt_dlp_field_names() {
        let parsed: Vec<GrabChapter> =
            serde_json::from_str(r#"[{"start_time":12.5,"end_time":40.0,"title":"Intro"}]"#)
                .expect("parses yt-dlp output");
        assert_eq!(parsed[0].start, 12.5);
        assert_eq!(parsed[0].end, 40.0);
    }

    #[test]
    fn chapters_parse_from_a_probe_payload() {
        let value = serde_json::json!({
            "chapters": [{ "start_time": 0.0, "end_time": 31.0, "title": "Introduction" }]
        });
        let chapters = collect_chapters(&value);
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].title, "Introduction");
        // A video without chapters must not error, just come back empty.
        assert!(collect_chapters(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn chapter_files_are_expected_outputs_and_do_not_clash_with_subtitles() {
        let mut options = options(false, false, false);
        options.chapters = true;
        options.chapter_formats = vec!["json".into(), "txt".into()];
        let expected = expected_outputs(&options);
        assert_eq!(expected.len(), 2);
        assert!(expected[0].matches("clip [abc].chapters.json"));
        assert!(expected[1].matches("clip [abc].chapters.txt"));
        // A chapters file must not satisfy a subtitle expectation.
        assert!(!ExpectedOutput::ChapterFile("json".into()).matches("clip [abc].de.srt"));
    }
}
