//! Job state and child-process execution: the single job slot, cancellation,
//! and the command runners every workflow goes through.

use std::{
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
};
use tauri::{AppHandle, Manager};

use crate::events::{emit_log, emit_progress, emit_status};

#[derive(Default)]
pub(crate) struct ConversionState {
    pub(crate) running: AtomicBool,
    pub(crate) cancel_requested: AtomicBool,
    pub(crate) child_pid: Mutex<Option<u32>>,
}

fn phase_for_line(line: &str) -> Option<(&'static str, &'static str)> {
    let lower = line.to_lowercase();
    if lower.contains("extracting") && lower.contains("audio") {
        Some(("extract", "Extracting German audio"))
    } else if lower.contains("transcribing with mlx whisper") {
        Some(("transcribe", "Transcribing German dialogue"))
    } else if lower.contains("creating editable dialogue project") {
        Some(("filter", "Building strict dialogue ranges"))
    } else if lower.contains("rendering segment") {
        Some(("render", "Rendering QuickTime-safe segments"))
    } else if lower.contains("parts concat") {
        Some(("stitch", "Stitching the final MP4"))
    } else if lower.contains("extracting url") || lower.contains("downloading webpage") {
        Some(("fetch", "Fetching material metadata"))
    } else if lower.contains("subtitles") || lower.contains(".srt") || lower.contains(".vtt") {
        Some(("subtitles", "Saving subtitles"))
    } else if lower.contains("[download]")
        || lower.contains("merging formats")
        || lower.contains("remuxing video")
    {
        Some(("download", "Downloading material"))
    } else {
        None
    }
}

fn forward_logs<R: Read + Send + 'static>(
    app: AppHandle,
    reader: R,
    stream: &'static str,
    detect_phases: bool,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if detect_phases {
                if let Some((phase, message)) = phase_for_line(&line) {
                    emit_status(&app, "running", phase, message, None);
                }
            }
            emit_log(&app, stream, line);
        }
    })
}

#[cfg(unix)]
fn prepare_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(not(unix))]
fn prepare_process(_command: &mut Command) {}

#[cfg(unix)]
pub(crate) fn terminate_process(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .arg("-TERM")
        .arg(format!("-{pid}"))
        .status()
        .map_err(|error| format!("Could not stop conversion: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not stop the conversion process.".into())
    }
}

#[cfg(windows)]
pub(crate) fn terminate_process(pid: u32) -> Result<(), String> {
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .map_err(|error| format!("Could not stop conversion: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("Could not stop the conversion process.".into())
    }
}

pub(crate) fn set_child_pid(state: &ConversionState, pid: Option<u32>) -> Result<(), String> {
    *state.child_pid.lock().map_err(|_| "Process lock failed.")? = pid;
    Ok(())
}

pub(crate) fn run_logged_command(
    app: &AppHandle,
    state: &ConversionState,
    command: &mut Command,
) -> Result<(), String> {
    run_logged_command_with(app, state, command, true)
}

// Shared skeleton for streaming runners: cancel checks, process-group setup,
// pid tracking, and waiting. The handlers decide what to do with each stream.
fn run_with_stream_handlers(
    state: &ConversionState,
    command: &mut Command,
    stdout_handler: impl FnOnce(std::process::ChildStdout) -> thread::JoinHandle<()>,
    stderr_handler: impl FnOnce(std::process::ChildStderr) -> thread::JoinHandle<()>,
) -> Result<(), String> {
    if state.cancel_requested.load(Ordering::SeqCst) {
        return Err("Conversion cancelled.".into());
    }

    prepare_process(command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not launch process: {error}"))?;
    set_child_pid(state, Some(child.id()))?;
    let stdout_thread = child.stdout.take().map(stdout_handler);
    let stderr_thread = child.stderr.take().map(stderr_handler);
    let result = child.wait();
    if let Some(handle) = stdout_thread {
        let _ = handle.join();
    }
    if let Some(handle) = stderr_thread {
        let _ = handle.join();
    }
    set_child_pid(state, None)?;

    if state.cancel_requested.load(Ordering::SeqCst) {
        return Err("Conversion cancelled.".into());
    }
    match result {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("Process exited with status {status}.")),
        Err(error) => Err(format!("Could not wait for process: {error}")),
    }
}

fn run_logged_command_with(
    app: &AppHandle,
    state: &ConversionState,
    command: &mut Command,
    detect_phases: bool,
) -> Result<(), String> {
    let app_stdout = app.clone();
    let app_stderr = app.clone();
    run_with_stream_handlers(
        state,
        command,
        move |stdout| forward_logs(app_stdout, stdout, "stdout", detect_phases),
        move |stderr| forward_logs(app_stderr, stderr, "stderr", detect_phases),
    )
}

// Like run_logged_command_plain, but additionally calls `observer` with every
// output line so the caller can derive progress from tool-specific output.
pub(crate) fn run_logged_command_observed(
    app: &AppHandle,
    state: &ConversionState,
    command: &mut Command,
    observer: impl Fn(&AppHandle, &str) + Send + Sync + 'static,
) -> Result<(), String> {
    fn observed_forward<R: Read + Send + 'static>(
        app: AppHandle,
        reader: R,
        stream: &'static str,
        observer: Arc<dyn Fn(&AppHandle, &str) + Send + Sync>,
    ) -> thread::JoinHandle<()> {
        thread::spawn(move || {
            for line in BufReader::new(reader).lines().map_while(Result::ok) {
                observer(&app, &line);
                emit_log(&app, stream, line);
            }
        })
    }

    let observer: Arc<dyn Fn(&AppHandle, &str) + Send + Sync> = Arc::new(observer);
    let app_stdout = app.clone();
    let app_stderr = app.clone();
    let observer_stderr = Arc::clone(&observer);
    run_with_stream_handlers(
        state,
        command,
        move |stdout| observed_forward(app_stdout, stdout, "stdout", observer),
        move |stderr| observed_forward(app_stderr, stderr, "stderr", observer_stderr),
    )
}

pub(crate) fn format_clock(seconds: f64) -> String {
    let total = seconds.max(0.0).round() as u64;
    format!("{}:{:02}:{:02}", total / 3600, (total % 3600) / 60, total % 60)
}

// Runs an ffmpeg command that was given `-nostats -progress pipe:1`. Progress
// key=value lines arrive on stdout and are turned into conversion-progress
// events instead of log noise; stderr is forwarded to the log as usual.
pub(crate) fn run_ffmpeg_with_progress(
    app: &AppHandle,
    state: &ConversionState,
    command: &mut Command,
    duration: Option<f64>,
) -> Result<(), String> {
    let app_progress = app.clone();
    let app_stderr = app.clone();
    run_with_stream_handlers(
        state,
        command,
        move |stdout| {
            thread::spawn(move || {
                let mut out_time = 0.0_f64;
                let mut speed = String::new();
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(value) = line.strip_prefix("out_time_us=") {
                        if let Ok(microseconds) = value.trim().parse::<f64>() {
                            out_time = microseconds / 1_000_000.0;
                        }
                    } else if let Some(value) = line.strip_prefix("speed=") {
                        speed = value.trim().trim_end_matches('x').to_string();
                    } else if let Some(value) = line.strip_prefix("progress=") {
                        let finished = value.trim() == "end";
                        let percent = if finished {
                            Some(100.0)
                        } else {
                            duration
                                .filter(|duration| *duration > 0.0)
                                .map(|duration| (out_time / duration * 100.0).clamp(0.0, 100.0))
                        };
                        let mut detail = format_clock(out_time);
                        if let Some(duration) = duration {
                            detail.push_str(&format!(" / {}", format_clock(duration)));
                        }
                        if !speed.is_empty() && speed != "N/A" {
                            detail.push_str(&format!(" at {speed}x"));
                        }
                        emit_progress(&app_progress, percent, detail);
                    }
                }
            })
        },
        move |stderr| forward_logs(app_stderr, stderr, "stderr", false),
    )
}

pub(crate) fn run_captured_command(
    app: &AppHandle,
    state: &ConversionState,
    command: &mut Command,
) -> Result<String, String> {
    if state.cancel_requested.load(Ordering::SeqCst) {
        return Err("Conversion cancelled.".into());
    }

    prepare_process(command);
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    let child = command
        .spawn()
        .map_err(|error| format!("Could not launch process: {error}"))?;
    set_child_pid(state, Some(child.id()))?;
    let result = child
        .wait_with_output()
        .map_err(|error| format!("Could not wait for process: {error}"));
    set_child_pid(state, None)?;

    if state.cancel_requested.load(Ordering::SeqCst) {
        return Err("Conversion cancelled.".into());
    }

    let output = result?;
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    for line in stderr.lines() {
        emit_log(app, "stderr", line);
    }
    if !output.status.success() {
        if stderr.is_empty() {
            return Err(format!("Process exited with status {}.", output.status));
        }
        return Err(stderr);
    }
    String::from_utf8(output.stdout)
        .map_err(|error| format!("Process output was not UTF-8: {error}"))
}

pub(crate) fn existing_file(raw: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw.trim());
    if path.is_file() {
        Ok(path)
    } else {
        Err("Choose an existing source file first.".into())
    }
}

/// Shared lifecycle for every start_* command: claim the single job slot,
/// announce the setup phase, run the worker on a background thread, and emit
/// the final complete/error status. Returns the expected output path so the
/// UI can display it immediately.
pub(crate) fn start_background_job(
    app: AppHandle,
    state: &ConversionState,
    setup_message: &'static str,
    done_message: &'static str,
    output_path: PathBuf,
    worker: impl FnOnce(&AppHandle, &ConversionState) -> Result<(), String> + Send + 'static,
) -> Result<String, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A process is already running.".into());
    }
    state.cancel_requested.store(false, Ordering::SeqCst);

    emit_status(&app, "running", "setup", setup_message, Some(&output_path));
    let display_path = output_path.display().to_string();
    thread::spawn(move || {
        let state = app.state::<ConversionState>();
        let result = worker(&app, &state);
        state.running.store(false, Ordering::SeqCst);
        let _ = set_child_pid(&state, None);

        match result {
            Ok(()) => emit_status(&app, "complete", "complete", done_message, Some(&output_path)),
            Err(error) => {
                emit_log(&app, "stderr", &error);
                emit_status(&app, "error", "error", &error, Some(&output_path));
            }
        }
    });

    Ok(display_path)
}
