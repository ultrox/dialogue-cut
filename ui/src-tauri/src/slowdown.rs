//! Slow-down workflow: re-times video and audio together for dubbing practice.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::events::emit_status;
use crate::media::{atempo_filter, Ffmpeg, MediaProbe};
use crate::process::ConversionState;
use crate::runtime::media_paths;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SlowdownOptions {
    pub(crate) video_path: String,
    pub(crate) speed: f64,
}

pub(crate) fn output_path_for_slowdown(video_path: &Path, speed: f64) -> Result<PathBuf, String> {
    let stem = video_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("The selected video filename is invalid.")?;
    Ok(video_path.with_file_name(format!("{stem}.slow-{speed:.2}x.mp4")))
}

pub(crate) fn run_slowdown(
    app: &AppHandle,
    state: &ConversionState,
    options: &SlowdownOptions,
    output_path: &Path,
) -> Result<(), String> {
    if !(0.1..=1.0).contains(&options.speed) {
        return Err("Choose a speed between 0.10x and 1.00x.".into());
    }

    let video_path = PathBuf::from(&options.video_path);
    let paths = media_paths(app, state)?;

    emit_status(
        app,
        "running",
        "inspect",
        "Inspecting the selected video",
        Some(output_path),
    );
    // The output runs 1/speed times longer than the input.
    let expected_duration = MediaProbe::new(&paths)
        .duration(&video_path)
        .map(|duration| duration / options.speed);

    emit_status(
        app,
        "running",
        "transcode",
        "Transcoding slowed video and audio",
        Some(output_path),
    );
    Ffmpeg::new(&paths)?
        .input(&video_path)
        .main_movie_streams()
        .video_filter(&format!("setpts=PTS/{:.5},format=yuv420p", options.speed))
        .audio_filter(&atempo_filter(options.speed))
        .encode_h264(22)
        .aac_audio()
        .mp4_faststart()
        .output(output_path)
        .run(app, state, expected_duration)
}
