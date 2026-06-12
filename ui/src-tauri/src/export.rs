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
use crate::runtime::{media_paths, ProcessorPaths};

// Each kept range is rendered as its own segment, then stitched with the
// concat demuxer. A single select-filter pass does not scale: hundreds of
// between() terms crash ffmpeg's expression parser with ENOMEM, and it would
// decode the whole movie anyway. Segment seeks only decode what is kept.
#[allow(clippy::too_many_arguments)]
fn render_segments(
    app: &AppHandle,
    state: &ConversionState,
    paths: &ProcessorPaths,
    video_path: &Path,
    ranges: &[ExportRange],
    total: f64,
    work_dir: &Path,
    output_path: &Path,
) -> Result<(), String> {
    let mut completed = 0.0_f64;
    let mut concat_list = String::new();
    for (index, range) in ranges.iter().enumerate() {
        emit_status(
            app,
            "running",
            "render",
            &format!("Rendering segment {} of {}", index + 1, ranges.len()),
            Some(output_path),
        );
        let part_name = format!("part-{index:05}.mp4");
        Ffmpeg::new(paths)?
            .seek(range.start)
            .input(video_path)
            .clip_duration(range.end - range.start)
            .main_movie_streams()
            .encode_h264(20)
            .aac_audio()
            .output(&work_dir.join(&part_name))
            .run_window(app, state, completed, Some(total))?;
        completed += range.end - range.start;
        concat_list.push_str(&format!("file '{part_name}'\n"));
    }

    let list_path = work_dir.join("concat.txt");
    fs::write(&list_path, concat_list)
        .map_err(|error| format!("Could not write {}: {error}", list_path.display()))?;

    emit_status(
        app,
        "running",
        "stitch",
        "Stitching the dialogue cut",
        Some(output_path),
    );
    Ffmpeg::new(paths)?
        .concat_input(&list_path)
        .copy_streams()
        .mp4_faststart()
        .output(output_path)
        .run(app, state, Some(total))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExportRange {
    pub(crate) start: f64,
    pub(crate) end: f64,
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

pub(crate) fn run_export(
    app: &AppHandle,
    state: &ConversionState,
    options: &ExportOptions,
    output_path: &Path,
) -> Result<(), String> {
    let video_path = PathBuf::from(&options.video_path);
    let total = validated_total(&options.ranges)?;
    let paths = media_paths(app, state)?;

    let stem = output_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("dialogue-cut");
    let work_dir = output_path.with_file_name(format!("{stem}.export-tmp"));
    fs::create_dir_all(&work_dir)
        .map_err(|error| format!("Could not create {}: {error}", work_dir.display()))?;

    let result = render_segments(
        app,
        state,
        &paths,
        &video_path,
        &options.ranges,
        total,
        &work_dir,
        output_path,
    );
    let _ = fs::remove_dir_all(&work_dir);
    result?;

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
