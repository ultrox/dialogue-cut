//! Merge workflow: combines multiple selected videos into one editor-friendly MP4.

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
pub(crate) struct MergeOptions {
    pub(crate) video_paths: Vec<String>,
    pub(crate) output_path: String,
}

pub(crate) fn validated_video_paths(raw_paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if raw_paths.len() < 2 {
        return Err("Choose at least two video files to merge.".into());
    }
    raw_paths
        .iter()
        .map(|path| existing_file(path))
        .collect::<Result<Vec<_>, _>>()
}

fn next_available_path(first_video: &Path) -> Result<PathBuf, String> {
    let stem = first_video
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("The first selected video filename is invalid.")?;
    let candidate = first_video.with_file_name(format!("{stem}.merged.mp4"));
    if !candidate.exists() {
        return Ok(candidate);
    }
    for index in 2..1000 {
        let candidate = first_video.with_file_name(format!("{stem}.merged-{index}.mp4"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Could not choose a unique merged output filename.".into())
}

pub(crate) fn output_path_for_merge(
    video_paths: &[PathBuf],
    output_path: &str,
) -> Result<PathBuf, String> {
    let first_video = video_paths
        .first()
        .ok_or("Choose at least two video files to merge.")?;
    let trimmed = output_path.trim();
    let mut path = if trimmed.is_empty() {
        next_available_path(first_video)?
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
    if video_paths.iter().any(|source| source == &path) {
        return Err("The merged output cannot overwrite one of the source files.".into());
    }
    Ok(path)
}

fn even_dimension(value: u32) -> u32 {
    (value.max(2) / 2) * 2
}

fn merge_filter(
    video_paths: &[PathBuf],
    durations: &[f64],
    has_audio: &[bool],
    width: u32,
    height: u32,
) -> String {
    let mut filter = String::new();
    for (index, _) in video_paths.iter().enumerate() {
        filter.push_str(&format!(
            "[{index}:v:0]scale={width}:{height}:force_original_aspect_ratio=decrease,\
pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p[v{index}];"
        ));
        if has_audio[index] {
            filter.push_str(&format!(
                "[{index}:a:0]aformat=sample_rates=48000:channel_layouts=stereo[a{index}];"
            ));
        } else {
            filter.push_str(&format!(
                "anullsrc=channel_layout=stereo:sample_rate=48000,\
atrim=0:duration={:.3},asetpts=N/SR/TB[a{index}];",
                durations[index]
            ));
        }
    }
    for index in 0..video_paths.len() {
        filter.push_str(&format!("[v{index}][a{index}]"));
    }
    filter.push_str(&format!("concat=n={}:v=1:a=1[v][a]", video_paths.len()));
    filter
}

pub(crate) fn run_merge(
    app: &AppHandle,
    state: &ConversionState,
    options: &MergeOptions,
    output_path: &Path,
) -> Result<(), String> {
    let video_paths = validated_video_paths(&options.video_paths)?;
    let paths = media_paths(app, state)?;
    let probe = MediaProbe::new(&paths);

    emit_status(
        app,
        "running",
        "inspect",
        "Inspecting selected videos",
        Some(output_path),
    );

    let (width, height) = probe
        .video_dimensions(&video_paths[0])
        .map(|(width, height)| (even_dimension(width), even_dimension(height)))
        .ok_or("Could not inspect the first video's dimensions.")?;
    let mut durations = Vec::with_capacity(video_paths.len());
    let mut audio_flags = Vec::with_capacity(video_paths.len());
    for path in &video_paths {
        let duration = probe
            .duration(path)
            .ok_or_else(|| format!("Could not inspect duration for {}.", path.display()))?;
        durations.push(duration);
        audio_flags.push(probe.has_audio(path));
    }
    let total_duration = durations.iter().sum::<f64>();

    emit_log(
        app,
        "stdout",
        format!(
            "Merging {} videos at {}x{} into {}",
            video_paths.len(),
            width,
            height,
            output_path.display()
        ),
    );
    emit_status(
        app,
        "running",
        "merge",
        "Merging selected videos",
        Some(output_path),
    );

    let mut command = Command::new(paths.tools_dir.join("ffmpeg"));
    command
        .arg("-hide_banner")
        .args(["-loglevel", "error"])
        .arg("-y")
        .args(["-nostats", "-progress", "pipe:1"]);
    for path in &video_paths {
        command.arg("-i").arg(path);
    }
    command
        .arg("-filter_complex")
        .arg(merge_filter(
            &video_paths,
            &durations,
            &audio_flags,
            width,
            height,
        ))
        .args(["-map", "[v]"])
        .args(["-map", "[a]"])
        .args(["-c:v", "libx264"])
        .args(["-preset", "veryfast"])
        .args(["-crf", "20"])
        .args(["-pix_fmt", "yuv420p"])
        .args(["-profile:v", "high"])
        .args(["-c:a", "aac"])
        .args(["-b:a", "192k"])
        .args(["-ac", "2"])
        .args(["-ar", "48000"])
        .args(["-movflags", "+faststart"])
        .arg(output_path);
    prepend_media_path(&mut command, &paths);
    run_ffmpeg_with_progress_window(app, state, &mut command, 0.0, Some(total_duration))
}
