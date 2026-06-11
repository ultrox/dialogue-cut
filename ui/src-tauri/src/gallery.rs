//! Material gallery: lists downloaded videos with duration and thumbnail.

use serde::{Deserialize, Serialize};
use std::{fs, path::Path, time::UNIX_EPOCH};
use tauri::AppHandle;

use crate::events::emit_log;
use crate::media::{thumbnail_data_url, MediaProbe};
use crate::process::ConversionState;
use crate::runtime::media_paths;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialGalleryOptions {
    pub(crate) directory: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MaterialVideo {
    path: String,
    file_name: String,
    duration: Option<f64>,
    size_bytes: Option<u64>,
    modified: Option<u64>,
    thumbnail_data_url: Option<String>,
}

fn is_supported_video(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mkv" | "mp4" | "mov" | "m4v" | "webm"
            )
        })
        .unwrap_or(false)
}

fn modified_seconds(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
}

pub(crate) fn list_material_videos_inner(
    app: &AppHandle,
    state: &ConversionState,
    directory: &Path,
) -> Result<Vec<MaterialVideo>, String> {
    fs::create_dir_all(directory)
        .map_err(|error| format!("Could not create {}: {error}", directory.display()))?;

    let mut files = fs::read_dir(directory)
        .map_err(|error| format!("Could not read {}: {error}", directory.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && is_supported_video(path))
        .collect::<Vec<_>>();
    files.sort_by_key(|path| std::cmp::Reverse(modified_seconds(path).unwrap_or(0)));
    files.truncate(48);

    let media = match media_paths(app, state) {
        Ok(paths) => Some(paths),
        Err(error) => {
            emit_log(
                app,
                "stderr",
                format!("Gallery thumbnails unavailable: {error}"),
            );
            None
        }
    };

    let probe = media.as_ref().map(MediaProbe::new);
    Ok(files
        .into_iter()
        .map(|path| {
            let metadata = fs::metadata(&path).ok();
            let duration = probe.as_ref().and_then(|probe| probe.duration(&path));
            let thumbnail_data_url = media
                .as_ref()
                .and_then(|paths| thumbnail_data_url(paths, &path, duration));
            MaterialVideo {
                file_name: path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("video")
                    .to_string(),
                path: path.display().to_string(),
                duration,
                size_bytes: metadata.as_ref().map(|metadata| metadata.len()),
                modified: modified_seconds(&path),
                thumbnail_data_url,
            }
        })
        .collect())
}
