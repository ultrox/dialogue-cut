//! Dialogue-cut export: renders the player's kept ranges into a new MP4 and
//! writes subtitles retimed to the new, compressed timeline.

use serde::Deserialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::AppHandle;

use crate::events::{emit_log, emit_status};
use crate::media::Ffmpeg;
use crate::process::ConversionState;
use crate::runtime::media_paths;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportRange {
    start: f64,
    end: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportOptions {
    pub(crate) video_path: String,
    pub(crate) ranges: Vec<ExportRange>,
    pub(crate) subtitles: String,
}

pub(crate) fn output_path_for_export(video_path: &Path) -> Result<PathBuf, String> {
    let stem = video_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("The selected video filename is invalid.")?;
    Ok(video_path.with_file_name(format!("{stem}.dialogue-cut.mp4")))
}

/// Returns the total kept duration, or an error when the ranges are unusable.
fn validated_total(ranges: &[ExportRange]) -> Result<f64, String> {
    if ranges.is_empty() {
        return Err("There are no dialogue segments to export.".into());
    }
    let mut previous_end = 0.0_f64;
    let mut total = 0.0_f64;
    for range in ranges {
        if range.end <= range.start || range.start < previous_end - 0.001 {
            return Err("Dialogue segments are not in playback order.".into());
        }
        total += range.end - range.start;
        previous_end = range.end;
    }
    Ok(total)
}

fn select_expression(ranges: &[ExportRange]) -> String {
    ranges
        .iter()
        .map(|range| format!("between(t,{:.3},{:.3})", range.start, range.end))
        .collect::<Vec<_>>()
        .join("+")
}

pub(crate) fn run_export(
    app: &AppHandle,
    state: &ConversionState,
    options: &ExportOptions,
    output_path: &Path,
) -> Result<(), String> {
    let video_path = PathBuf::from(&options.video_path);
    let total = validated_total(&options.ranges)?;
    let paths = media_paths(app, state)?;

    emit_status(
        app,
        "running",
        "render",
        &format!("Rendering {} dialogue segments", options.ranges.len()),
        Some(output_path),
    );
    // One pass over the source: select/aselect keep only the wanted ranges
    // and the setpts/asetpts re-stamp them into one continuous timeline.
    // The expression quotes ('...') are for ffmpeg's filter parser, which
    // would otherwise read the commas inside between() as separators.
    let expression = select_expression(&options.ranges);
    Ffmpeg::new(&paths)?
        .input(&video_path)
        .main_movie_streams()
        .video_filter(&format!("select='{expression}',setpts=N/FRAME_RATE/TB"))
        .audio_filter(&format!("aselect='{expression}',asetpts=N/SR/TB"))
        .encode_h264(20)
        .aac_audio()
        .mp4_faststart()
        .output(output_path)
        .run(app, state, Some(total))?;

    if !options.subtitles.trim().is_empty() {
        emit_status(
            app,
            "running",
            "subtitles",
            "Writing retimed subtitles",
            Some(output_path),
        );
        let subtitle_path = output_path.with_extension("srt");
        fs::write(&subtitle_path, &options.subtitles)
            .map_err(|error| format!("Could not save {}: {error}", subtitle_path.display()))?;
        emit_log(app, "stdout", format!("Saved {}", subtitle_path.display()));
    }
    Ok(())
}
