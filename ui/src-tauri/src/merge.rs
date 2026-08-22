//! Merge workflow: combines multiple selected media files into one output file.

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
    #[serde(alias = "videoPaths")]
    pub(crate) media_paths: Vec<String>,
    pub(crate) output_path: String,
}

pub(crate) fn validated_media_paths(raw_paths: &[String]) -> Result<Vec<PathBuf>, String> {
    if raw_paths.len() < 2 {
        return Err("Choose at least two media files to merge.".into());
    }
    raw_paths
        .iter()
        .map(|path| existing_file(path))
        .collect::<Result<Vec<_>, _>>()
}

fn path_looks_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            matches!(
                extension.to_ascii_lowercase().as_str(),
                "mp3" | "m4a" | "wav" | "aac" | "flac" | "ogg"
            )
        })
}

fn output_extension_for_merge(first_media: &Path) -> &'static str {
    if path_looks_audio(first_media) {
        "m4a"
    } else {
        "mp4"
    }
}

fn next_available_path(first_media: &Path) -> Result<PathBuf, String> {
    let stem = first_media
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("The first selected media filename is invalid.")?;
    let extension = output_extension_for_merge(first_media);
    let candidate = first_media.with_file_name(format!("{stem}.merged.{extension}"));
    if !candidate.exists() {
        return Ok(candidate);
    }
    for index in 2..1000 {
        let candidate = first_media.with_file_name(format!("{stem}.merged-{index}.{extension}"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Could not choose a unique merged output filename.".into())
}

pub(crate) fn output_path_for_merge(
    media_paths: &[PathBuf],
    output_path: &str,
) -> Result<PathBuf, String> {
    let first_media = media_paths
        .first()
        .ok_or("Choose at least two media files to merge.")?;
    let trimmed = output_path.trim();
    let mut path = if trimmed.is_empty() {
        next_available_path(first_media)?
    } else {
        PathBuf::from(trimmed)
    };
    let expected_extension = output_extension_for_merge(first_media);
    let extension_is_expected = path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(expected_extension));
    if !extension_is_expected {
        path.set_extension(expected_extension);
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
    if media_paths.iter().any(|source| source == &path) {
        return Err("The merged output cannot overwrite one of the source files.".into());
    }
    Ok(path)
}

fn even_dimension(value: u32) -> u32 {
    (value.max(2) / 2) * 2
}

fn merge_filter(
    input_count: usize,
    durations: &[f64],
    has_audio: &[bool],
    width: u32,
    height: u32,
) -> String {
    let mut filter = String::new();
    for index in 0..input_count {
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
    for index in 0..input_count {
        filter.push_str(&format!("[v{index}][a{index}]"));
    }
    filter.push_str(&format!("concat=n={input_count}:v=1:a=1[v][a]"));
    filter
}

fn audio_merge_filter(input_count: usize) -> String {
    let mut filter = String::new();
    for index in 0..input_count {
        filter.push_str(&format!(
            "[{index}:a:0]aformat=sample_rates=48000:channel_layouts=stereo[a{index}];"
        ));
    }
    for index in 0..input_count {
        filter.push_str(&format!("[a{index}]"));
    }
    filter.push_str(&format!("concat=n={input_count}:v=0:a=1[a]"));
    filter
}

struct MergeInputInfo {
    duration: f64,
    has_audio: bool,
    video_dimensions: Option<(u32, u32)>,
}

pub(crate) fn run_merge(
    app: &AppHandle,
    state: &ConversionState,
    options: &MergeOptions,
    output_path: &Path,
) -> Result<(), String> {
    let input_paths = validated_media_paths(&options.media_paths)?;
    let paths = media_paths(app, state)?;
    let probe = MediaProbe::new(&paths);

    emit_status(
        app,
        "running",
        "inspect",
        "Inspecting selected media",
        Some(output_path),
    );

    let mut input_infos = Vec::with_capacity(input_paths.len());
    for path in &input_paths {
        let duration = probe
            .duration(path)
            .ok_or_else(|| format!("Could not inspect duration for {}.", path.display()))?;
        let has_audio = probe.has_audio(path);
        let video_dimensions = probe.video_dimensions(path);
        if !has_audio && video_dimensions.is_none() {
            return Err(format!(
                "{} does not contain a readable audio or video stream.",
                path.display()
            ));
        }
        input_infos.push(MergeInputInfo {
            duration,
            has_audio,
            video_dimensions,
        });
    }
    let has_video_inputs = input_infos
        .iter()
        .any(|info| info.video_dimensions.is_some());
    let has_audio_only_inputs = input_infos
        .iter()
        .any(|info| info.video_dimensions.is_none());
    if has_video_inputs && has_audio_only_inputs {
        return Err("Choose either only video files or only audio files for one merge.".into());
    }
    if !has_video_inputs && input_infos.iter().any(|info| !info.has_audio) {
        return Err("Every selected audio file must contain an audio stream.".into());
    }

    let durations = input_infos
        .iter()
        .map(|info| info.duration)
        .collect::<Vec<_>>();
    let total_duration = durations.iter().sum::<f64>();

    if has_video_inputs {
        let (width, height) = input_infos[0]
            .video_dimensions
            .map(|(width, height)| (even_dimension(width), even_dimension(height)))
            .ok_or("Could not inspect the first video's dimensions.")?;
        let audio_flags = input_infos
            .iter()
            .map(|info| info.has_audio)
            .collect::<Vec<_>>();
        emit_log(
            app,
            "stdout",
            format!(
                "Merging {} videos at {}x{} into {}",
                input_paths.len(),
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
        for path in &input_paths {
            command.arg("-i").arg(path);
        }
        command
            .arg("-filter_complex")
            .arg(merge_filter(
                input_paths.len(),
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
        return run_ffmpeg_with_progress_window(
            app,
            state,
            &mut command,
            0.0,
            Some(total_duration),
        );
    }

    emit_log(
        app,
        "stdout",
        format!(
            "Merging {} audio files into {}",
            input_paths.len(),
            output_path.display()
        ),
    );
    emit_status(
        app,
        "running",
        "merge",
        "Merging selected audio",
        Some(output_path),
    );

    let mut command = Command::new(paths.tools_dir.join("ffmpeg"));
    command
        .arg("-hide_banner")
        .args(["-loglevel", "error"])
        .arg("-y")
        .args(["-nostats", "-progress", "pipe:1"]);
    for path in &input_paths {
        command.arg("-i").arg(path);
    }
    command
        .arg("-filter_complex")
        .arg(audio_merge_filter(input_paths.len()))
        .args(["-map", "[a]"])
        .args(["-c:a", "aac"])
        .args(["-b:a", "192k"])
        .args(["-ac", "2"])
        .args(["-ar", "48000"])
        .args(["-movflags", "+faststart"])
        .arg(output_path);
    prepend_media_path(&mut command, &paths);
    run_ffmpeg_with_progress_window(app, state, &mut command, 0.0, Some(total_duration))
}
