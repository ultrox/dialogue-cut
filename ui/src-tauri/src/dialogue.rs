//! Dialogue-cut workflow: drives the bundled dialogue-only.py processor.

use serde::Deserialize;
use std::{
    path::{Path, PathBuf},
    process::Command,
};
use tauri::AppHandle;

use crate::events::emit_status;
use crate::process::{run_logged_command, ConversionState};
use crate::runtime::{prepend_runtime_path, processor_paths};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversionOptions {
    pub(crate) video_path: String,
    pub(crate) force_transcribe: bool,
    pub(crate) pre_pad: f64,
    pub(crate) post_pad: f64,
    pub(crate) merge_gap: f64,
    pub(crate) keep_cue_classes: String,
    pub(crate) keep_sources: String,
}

pub(crate) fn output_path_for(video_path: &Path) -> Result<PathBuf, String> {
    let stem = video_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("The selected video filename is invalid.")?;
    Ok(video_path.with_file_name(format!("{stem}.dialogue-only.mp4")))
}

pub(crate) fn run_conversion(
    app: &AppHandle,
    state: &ConversionState,
    options: &ConversionOptions,
) -> Result<(), String> {
    let video_path = PathBuf::from(&options.video_path);
    let paths = processor_paths(app, state)?;
    if !paths.script.is_file() {
        return Err(format!(
            "Dialogue processor not found at {}.",
            paths.script.display()
        ));
    }

    emit_status(
        app,
        "running",
        "inspect",
        "Inspecting the selected video",
        None,
    );
    let mut command = Command::new(&paths.python);
    command
        .arg(&paths.script)
        .arg(&video_path)
        .args(["--venv-dir", &paths.venv_dir.display().to_string()])
        .args(["--pre-pad", &options.pre_pad.to_string()])
        .args(["--post-pad", &options.post_pad.to_string()])
        .args(["--merge-gap", &options.merge_gap.to_string()])
        .args(["--keep-cue-classes", &options.keep_cue_classes])
        .args(["--keep-sources", &options.keep_sources]);
    if options.force_transcribe {
        command.arg("--force-transcribe");
    }
    prepend_runtime_path(&mut command, &paths);
    run_logged_command(app, state, &mut command)
}
