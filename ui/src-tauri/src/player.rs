//! Subtitle player: discovering and reading subtitle files so the UI can
//! follow a movie cue by cue before building a dialogue-only cut.

use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

const MAX_SUBTITLE_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubtitleListOptions {
    pub(crate) video_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubtitleReadOptions {
    pub(crate) path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubtitleFile {
    path: String,
    file_name: String,
}

fn is_subtitle(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| matches!(extension.to_ascii_lowercase().as_str(), "srt" | "vtt"))
        .unwrap_or(false)
}

// Outputs of the other tabs add suffixes to the original name; strip them so
// "movie.converted.mp4" still matches subtitles named after "movie".
fn base_stem(stem: &str) -> &str {
    for marker in [".converted", ".dialogue-only"] {
        if let Some(stripped) = stem.strip_suffix(marker) {
            return stripped;
        }
    }
    if let Some(index) = stem.find(".slow-") {
        return &stem[..index];
    }
    stem
}

/// Lists subtitle files in the video's directory, ones matching the video
/// name first.
pub(crate) fn list_subtitle_files(video_path: &Path) -> Vec<SubtitleFile> {
    let Some(directory) = video_path.parent() else {
        return Vec::new();
    };
    let stem = video_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let base = base_stem(stem);

    let Ok(entries) = fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut files = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_subtitle(path))
        .filter_map(|path| {
            let file_name = path.file_name()?.to_str()?.to_string();
            let matches_video =
                !stem.is_empty() && (file_name.starts_with(stem) || file_name.starts_with(base));
            Some((matches_video, file_name, path.display().to_string()))
        })
        .collect::<Vec<_>>();

    files.sort_by(|a, b| (!a.0, a.1.to_lowercase()).cmp(&(!b.0, b.1.to_lowercase())));
    files
        .into_iter()
        .map(|(_, file_name, path)| SubtitleFile { path, file_name })
        .collect()
}

pub(crate) fn read_subtitle_file(path: &Path) -> Result<String, String> {
    if !is_subtitle(path) {
        return Err("Choose an .srt or .vtt subtitle file.".into());
    }
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    if metadata.len() > MAX_SUBTITLE_BYTES {
        return Err(format!("{} is too large for a subtitle file.", path.display()));
    }
    let bytes =
        fs::read(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    // Subtitles in the wild are not always UTF-8; lossy decoding keeps the
    // cues usable instead of failing the whole file.
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
