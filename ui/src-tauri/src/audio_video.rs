//! Audio-video workflow: turns one audio file into a static-background MP4.

use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    process::Command,
};
use tauri::AppHandle;

use crate::events::{emit_log, emit_status};
use crate::media::MediaProbe;
use crate::process::{existing_file, run_ffmpeg_with_progress_window, ConversionState};
use crate::runtime::{media_paths, prepend_media_path};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioVideoOptions {
    pub(crate) audio_path: String,
    pub(crate) output_path: String,
    pub(crate) resolution: String,
    pub(crate) background: String,
}

pub(crate) fn output_path_for_audio_video(
    audio_path: &Path,
    output_path: &str,
) -> Result<PathBuf, String> {
    let trimmed = output_path.trim();
    let mut path = if trimmed.is_empty() {
        let stem = audio_path
            .file_stem()
            .and_then(|value| value.to_str())
            .ok_or("The selected audio filename is invalid.")?;
        audio_path.with_file_name(format!("{stem}.audio-video.mp4"))
    } else {
        PathBuf::from(trimmed)
    };
    let extension_is_mp4 = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"));
    if !extension_is_mp4 {
        path.set_extension("mp4");
    }
    if path.is_dir() {
        return Err("Choose an output file, not a folder.".into());
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!(
                "Output folder does not exist: {}.",
                parent.display()
            ));
        }
    }
    if audio_path == path.as_path() {
        return Err("The video output cannot overwrite the source audio file.".into());
    }
    Ok(path)
}

fn validated_resolution(raw: &str) -> Result<&'static str, String> {
    match raw {
        "1920x1080" => Ok("1920x1080"),
        "1280x720" => Ok("1280x720"),
        "1080x1080" => Ok("1080x1080"),
        _ => Err("Choose a supported video resolution.".into()),
    }
}

fn validated_background(raw: &str) -> Result<String, String> {
    let background = raw.trim().trim_start_matches('#');
    if background.len() == 6 && background.chars().all(|value| value.is_ascii_hexdigit()) {
        Ok(background.to_ascii_lowercase())
    } else {
        Err("Choose a valid six-digit background color.".into())
    }
}

pub(crate) fn run_audio_video(
    app: &AppHandle,
    state: &ConversionState,
    options: &AudioVideoOptions,
    output_path: &Path,
) -> Result<(), String> {
    let audio_path = existing_file(&options.audio_path)?;
    let resolution = validated_resolution(&options.resolution)?;
    let background = validated_background(&options.background)?;
    let paths = media_paths(app, state)?;
    let probe = MediaProbe::new(&paths);

    emit_status(
        app,
        "running",
        "inspect",
        "Inspecting selected audio",
        Some(output_path),
    );
    if !probe.has_audio(&audio_path) {
        return Err("The selected file does not contain an audio stream.".into());
    }
    let duration = probe
        .duration(&audio_path)
        .ok_or("Could not inspect the selected audio duration.")?;
    if duration <= 0.0 {
        return Err("The selected audio has no playable duration.".into());
    }

    emit_log(
        app,
        "stdout",
        format!("Creating {} video for {}", resolution, audio_path.display()),
    );
    emit_status(
        app,
        "running",
        "render",
        "Rendering static-background video",
        Some(output_path),
    );

    let color_source = format!("color=c=0x{background}:s={resolution}:r=30:d={duration:.3}");
    let mut command = Command::new(paths.tools_dir.join("ffmpeg"));
    command
        .arg("-hide_banner")
        .args(["-loglevel", "error"])
        .arg("-y")
        .args(["-nostats", "-progress", "pipe:1"])
        .args(["-f", "lavfi"])
        .arg("-i")
        .arg(color_source)
        .arg("-i")
        .arg(&audio_path)
        .args(["-map", "0:v:0"])
        .args(["-map", "1:a:0"])
        .args(["-c:v", "libx264"])
        .args(["-preset", "veryfast"])
        .args(["-crf", "18"])
        .args(["-pix_fmt", "yuv420p"])
        .args(["-profile:v", "high"])
        .args(["-c:a", "aac"])
        .args(["-b:a", "192k"])
        .args(["-ac", "2"])
        .args(["-ar", "48000"])
        .arg("-shortest")
        .args(["-movflags", "+faststart"])
        .arg(output_path);
    prepend_media_path(&mut command, &paths);
    run_ffmpeg_with_progress_window(app, state, &mut command, 0.0, Some(duration))
}
