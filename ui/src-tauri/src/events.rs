//! Event payloads and emit helpers for everything the UI listens to.

use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversionStatus {
    status: String,
    phase: String,
    message: String,
    output_path: Option<String>,
}

#[derive(Clone, Serialize)]
struct ConversionLog {
    stream: String,
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConversionProgress {
    percent: Option<f64>,
    detail: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeStatus {
    pub(crate) ready: bool,
    pub(crate) message: String,
}

pub(crate) fn emit_status(
    app: &AppHandle,
    status: &str,
    phase: &str,
    message: &str,
    output_path: Option<&Path>,
) {
    let _ = app.emit(
        "conversion-state",
        ConversionStatus {
            status: status.into(),
            phase: phase.into(),
            message: message.into(),
            output_path: output_path.map(|path| path.display().to_string()),
        },
    );
}

pub(crate) fn emit_log(app: &AppHandle, stream: &str, line: impl Into<String>) {
    let _ = app.emit(
        "conversion-log",
        ConversionLog {
            stream: stream.into(),
            line: line.into(),
        },
    );
}

pub(crate) fn emit_progress(app: &AppHandle, percent: Option<f64>, detail: impl Into<String>) {
    let _ = app.emit(
        "conversion-progress",
        ConversionProgress {
            percent,
            detail: detail.into(),
        },
    );
}

pub(crate) fn emit_runtime_status(app: &AppHandle, ready: bool, message: &str) {
    let _ = app.emit(
        "runtime-state",
        RuntimeStatus {
            ready,
            message: message.into(),
        },
    );
}
