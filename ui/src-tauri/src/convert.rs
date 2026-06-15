//! Converter workflow: MKV (or anything else) into an editor-friendly MP4.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::events::{emit_log, emit_status};
use crate::media::{Ffmpeg, MediaProbe};
use crate::process::ConversionState;
use crate::runtime::media_paths;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConvertOptions {
    pub(crate) video_path: String,
    pub(crate) mode: String,
}

pub(crate) fn output_path_for_convert(video_path: &Path) -> Result<PathBuf, String> {
    let stem = video_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("The selected video filename is invalid.")?;
    let candidate = video_path.with_file_name(format!("{stem}.mp4"));
    // Never overwrite the source or an unrelated file that already has the
    // target name; fall back to a clearly-marked output instead.
    if candidate != *video_path && !candidate.exists() {
        Ok(candidate)
    } else {
        Ok(video_path.with_file_name(format!("{stem}.converted.mp4")))
    }
}

pub(crate) fn run_convert(
    app: &AppHandle,
    state: &ConversionState,
    options: &ConvertOptions,
    output_path: &Path,
) -> Result<(), String> {
    let video_path = PathBuf::from(&options.video_path);
    let paths = media_paths(app, state)?;

    emit_status(
        app,
        "running",
        "inspect",
        "Inspecting the selected video",
        Some(output_path),
    );
    let probe = MediaProbe::new(&paths);
    let source_has_audio = probe.has_audio(&video_path);
    let codec = probe.video_codec(&video_path);
    if let Some(codec) = &codec {
        emit_log(app, "stdout", format!("Source video codec: {codec}"));
    }
    let duration = probe.duration(&video_path);

    let ffmpeg = Ffmpeg::new(&paths)?.input(&video_path).main_movie_streams();
    let ffmpeg = match options.mode.as_str() {
        "remux" => {
            emit_status(
                app,
                "running",
                "convert",
                "Remuxing into MP4 (copying video)",
                Some(output_path),
            );
            ffmpeg.copy_video(codec.as_deref() == Some("hevc"))
        }
        "reencode" => {
            emit_status(
                app,
                "running",
                "convert",
                "Re-encoding to H.264/AAC",
                Some(output_path),
            );
            ffmpeg.encode_h264(20)
        }
        other => return Err(format!("Unknown conversion mode: {other}.")),
    };
    ffmpeg
        .aac_audio()
        .mp4_faststart()
        .output(output_path)
        .run(app, state, duration)?;

    if source_has_audio {
        if !probe.has_audio(output_path) {
            return Err("Converted MP4 has no audio stream. The source had audio, so this output is not usable.".into());
        }
        let audio_codec = probe
            .audio_codec(output_path)
            .ok_or("Could not inspect converted MP4 audio codec.")?;
        if audio_codec != "aac" {
            return Err(format!(
                "Converted MP4 audio is {audio_codec}, expected AAC. This output may not play correctly."
            ));
        }
        let channels = probe
            .audio_channels(output_path)
            .ok_or("Could not inspect converted MP4 audio channels.")?;
        if channels != 2 {
            return Err(format!(
                "Converted MP4 audio is {channels} channels, expected stereo. This output may play silently in some players."
            ));
        }
        emit_log(app, "stdout", "Verified converted audio: AAC stereo");
    }

    Ok(())
}
