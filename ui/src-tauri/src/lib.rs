use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter, Manager, State};

const PYTHON_ARCHIVE: &str =
    "cpython-3.14.5+20260510-aarch64-apple-darwin-install_only_stripped.tar.gz";
const PYTHON_SHA256: &str = "1bb0b3d45448dfe7e916dc62144cfd7d7a611dc6ccf05b8bb71662cc5c2a1ad2";
const PYTHON_URL: &str = "https://github.com/astral-sh/python-build-standalone/releases/download/20260510/cpython-3.14.5%2B20260510-aarch64-apple-darwin-install_only_stripped.tar.gz";
const FFMPEG_SHA256: &str = "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584";
const FFMPEG_URL: &str =
    "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64";
const FFPROBE_SHA256: &str = "bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64";
const FFPROBE_URL: &str =
    "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-darwin-arm64";
const MLX_WHISPER_PACKAGE: &str = "mlx-whisper==0.4.3";

#[derive(Default)]
struct ConversionState {
    running: AtomicBool,
    cancel_requested: AtomicBool,
    child_pid: Mutex<Option<u32>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConversionOptions {
    video_path: String,
    force_transcribe: bool,
    pre_pad: f64,
    post_pad: f64,
    merge_gap: f64,
    keep_cue_classes: String,
    keep_sources: String,
}

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
struct RuntimeStatus {
    ready: bool,
    message: String,
}

struct ProcessorPaths {
    python: PathBuf,
    venv_dir: PathBuf,
    script: PathBuf,
    tools_dir: PathBuf,
    hf_home: PathBuf,
}

fn local_tool_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn local_processor_paths() -> ProcessorPaths {
    let tool_dir = local_tool_dir();
    ProcessorPaths {
        python: tool_dir.join(".dialogue-venv/bin/python"),
        venv_dir: tool_dir.join(".dialogue-venv"),
        script: tool_dir.join("dialogue-only.py"),
        tools_dir: PathBuf::from("/opt/homebrew/bin"),
        hf_home: dirs_home().join(".cache/huggingface"),
    }
}

fn dirs_home() -> PathBuf {
    env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_local_data_dir()
        .map_err(|error| format!("Could not locate Application Support: {error}"))
}

fn private_processor_paths(app: &AppHandle) -> Result<ProcessorPaths, String> {
    let data_dir = app_data_dir(app)?;
    let python_dir = data_dir.join("runtime/python");
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| format!("Could not locate bundled processor files: {error}"))?;
    Ok(ProcessorPaths {
        python: python_dir.join("bin/python3"),
        venv_dir: python_dir,
        script: resource_dir.join("processor/dialogue-only.py"),
        tools_dir: data_dir.join("tools/bin"),
        hf_home: data_dir.join("cache/huggingface"),
    })
}

fn private_runtime_ready(paths: &ProcessorPaths) -> bool {
    paths.python.is_file()
        && paths.script.is_file()
        && paths.venv_dir.join("bin/mlx_whisper").is_file()
        && paths.tools_dir.join("ffmpeg").is_file()
        && paths.tools_dir.join("ffprobe").is_file()
}

fn local_runtime_ready(paths: &ProcessorPaths) -> bool {
    paths.python.is_file()
        && paths.script.is_file()
        && paths.venv_dir.join("bin/mlx_whisper").is_file()
}

fn runtime_status_inner(app: &AppHandle) -> RuntimeStatus {
    let local = local_processor_paths();
    if cfg!(debug_assertions) && local_runtime_ready(&local) {
        return RuntimeStatus {
            ready: true,
            message: "Using the local development runtime".into(),
        };
    }

    match private_processor_paths(app) {
        Ok(paths) if private_runtime_ready(&paths) => RuntimeStatus {
            ready: true,
            message: "Private Whisper runtime is installed".into(),
        },
        Ok(_) => RuntimeStatus {
            ready: false,
            message: "Private runtime downloads automatically on first conversion".into(),
        },
        Err(error) => RuntimeStatus {
            ready: false,
            message: error,
        },
    }
}

fn emit_runtime_status(app: &AppHandle, ready: bool, message: &str) {
    let _ = app.emit(
        "runtime-state",
        RuntimeStatus {
            ready,
            message: message.into(),
        },
    );
}

fn output_path_for(video_path: &Path) -> Result<PathBuf, String> {
    let stem = video_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("The selected video filename is invalid.")?;
    Ok(video_path.with_file_name(format!("{stem}.dialogue-only.mp4")))
}

fn emit_status(
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

fn emit_log(app: &AppHandle, stream: &str, line: impl Into<String>) {
    let _ = app.emit(
        "conversion-log",
        ConversionLog {
            stream: stream.into(),
            line: line.into(),
        },
    );
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
    } else {
        None
    }
}

fn forward_logs<R: Read + Send + 'static>(
    app: AppHandle,
    reader: R,
    stream: &'static str,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if let Some((phase, message)) = phase_for_line(&line) {
                emit_status(&app, "running", phase, message, None);
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
fn terminate_process(pid: u32) -> Result<(), String> {
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
fn terminate_process(pid: u32) -> Result<(), String> {
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

fn set_child_pid(state: &ConversionState, pid: Option<u32>) -> Result<(), String> {
    *state
        .child_pid
        .lock()
        .map_err(|_| "Process lock failed.")? = pid;
    Ok(())
}

fn run_logged_command(
    app: &AppHandle,
    state: &ConversionState,
    command: &mut Command,
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
    let stdout_thread = child
        .stdout
        .take()
        .map(|stdout| forward_logs(app.clone(), stdout, "stdout"));
    let stderr_thread = child
        .stderr
        .take()
        .map(|stderr| forward_logs(app.clone(), stderr, "stderr"));
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

fn checksum_matches(path: &Path, expected: &str) -> bool {
    let Ok(output) = Command::new("/usr/bin/shasum")
        .args(["-a", "256"])
        .arg(path)
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .next()
        == Some(expected)
}

fn download_verified(
    app: &AppHandle,
    state: &ConversionState,
    url: &str,
    sha256: &str,
    destination: &Path,
) -> Result<(), String> {
    if destination.is_file() && checksum_matches(destination, sha256) {
        return Ok(());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }

    let temporary = destination.with_extension("download");
    let _ = fs::remove_file(&temporary);
    emit_log(app, "stdout", format!("Downloading {}...", destination.display()));
    let mut command = Command::new("/usr/bin/curl");
    command
        .args(["--location", "--fail", "--show-error", "--progress-bar", "--output"])
        .arg(&temporary)
        .arg(url);
    run_logged_command(app, state, &mut command)?;
    if !checksum_matches(&temporary, sha256) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Checksum verification failed for {}.",
            destination.display()
        ));
    }
    fs::rename(&temporary, destination)
        .map_err(|error| format!("Could not save {}: {error}", destination.display()))?;
    Ok(())
}

#[cfg(unix)]
fn make_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = fs::metadata(path)
        .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?
        .permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions)
        .map_err(|error| format!("Could not make {} executable: {error}", path.display()))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn prepend_runtime_path(command: &mut Command, paths: &ProcessorPaths) {
    let inherited = env::var_os("PATH").unwrap_or_default();
    let mut entries = vec![paths.tools_dir.clone(), paths.venv_dir.join("bin")];
    entries.extend(env::split_paths(&inherited));
    if let Ok(path) = env::join_paths(entries) {
        command.env("PATH", path);
    }
    command
        .env("HF_HOME", &paths.hf_home)
        .env("PYTHONNOUSERSITE", "1");
}

fn install_python(
    app: &AppHandle,
    state: &ConversionState,
    paths: &ProcessorPaths,
    data_dir: &Path,
) -> Result<(), String> {
    if paths.python.is_file() {
        return Ok(());
    }
    let runtime_dir = data_dir.join("runtime");
    let archive = data_dir.join("downloads").join(PYTHON_ARCHIVE);
    download_verified(app, state, PYTHON_URL, PYTHON_SHA256, &archive)?;
    let _ = fs::remove_dir_all(&paths.venv_dir);
    fs::create_dir_all(&runtime_dir)
        .map_err(|error| format!("Could not create {}: {error}", runtime_dir.display()))?;
    emit_log(app, "stdout", "Extracting private Python runtime...");
    let mut command = Command::new("/usr/bin/tar");
    command.args(["-xzf"]).arg(&archive).arg("-C").arg(&runtime_dir);
    run_logged_command(app, state, &mut command)?;
    if paths.python.is_file() {
        Ok(())
    } else {
        Err("Private Python runtime did not contain bin/python3.".into())
    }
}

fn install_static_tool(
    app: &AppHandle,
    state: &ConversionState,
    paths: &ProcessorPaths,
    name: &str,
    url: &str,
    sha256: &str,
) -> Result<(), String> {
    let destination = paths.tools_dir.join(name);
    download_verified(app, state, url, sha256, &destination)?;
    make_executable(&destination)
}

fn python_has_pip(paths: &ProcessorPaths) -> bool {
    Command::new(&paths.python)
        .args(["-m", "pip", "--version"])
        .env("PYTHONNOUSERSITE", "1")
        .output()
        .is_ok_and(|output| output.status.success())
}

fn install_whisper(
    app: &AppHandle,
    state: &ConversionState,
    paths: &ProcessorPaths,
) -> Result<(), String> {
    if paths.venv_dir.join("bin/mlx_whisper").is_file() {
        return Ok(());
    }
    if !python_has_pip(paths) {
        emit_log(app, "stdout", "Installing pip into the private runtime...");
        let mut command = Command::new(&paths.python);
        command.args(["-m", "ensurepip", "--upgrade"]);
        prepend_runtime_path(&mut command, paths);
        run_logged_command(app, state, &mut command)?;
    }
    emit_log(
        app,
        "stdout",
        "Installing the private Whisper runtime. This is the longest first-run step...",
    );
    let mut command = Command::new(&paths.python);
    command.args([
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-warn-script-location",
        MLX_WHISPER_PACKAGE,
    ]);
    prepend_runtime_path(&mut command, paths);
    run_logged_command(app, state, &mut command)?;
    if paths.venv_dir.join("bin/mlx_whisper").is_file() {
        Ok(())
    } else {
        Err("mlx_whisper was not installed into the private runtime.".into())
    }
}

fn ensure_private_runtime(
    app: &AppHandle,
    state: &ConversionState,
) -> Result<ProcessorPaths, String> {
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    return Err("This build currently supports Apple Silicon Macs only.".into());

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let paths = private_processor_paths(app)?;
        if private_runtime_ready(&paths) {
            return Ok(paths);
        }

        emit_status(
            app,
            "running",
            "setup",
            "Preparing the private runtime",
            None,
        );
        emit_runtime_status(
            app,
            false,
            "Installing private runtime. First setup can take several minutes.",
        );
        let data_dir = app_data_dir(app)?;
        fs::create_dir_all(paths.hf_home.clone())
            .map_err(|error| format!("Could not create model cache: {error}"))?;
        install_python(app, state, &paths, &data_dir)?;
        install_static_tool(app, state, &paths, "ffmpeg", FFMPEG_URL, FFMPEG_SHA256)?;
        install_static_tool(app, state, &paths, "ffprobe", FFPROBE_URL, FFPROBE_SHA256)?;
        install_whisper(app, state, &paths)?;
        emit_runtime_status(app, true, "Private Whisper runtime is installed");
        Ok(paths)
    }
}

fn processor_paths(app: &AppHandle, state: &ConversionState) -> Result<ProcessorPaths, String> {
    let local = local_processor_paths();
    if cfg!(debug_assertions) && local_runtime_ready(&local) {
        return Ok(local);
    }
    ensure_private_runtime(app, state)
}

fn run_conversion(
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

#[tauri::command]
fn get_runtime_status(app: AppHandle) -> RuntimeStatus {
    runtime_status_inner(&app)
}

#[tauri::command]
fn start_conversion(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: ConversionOptions,
) -> Result<String, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A conversion is already running.".into());
    }
    state.cancel_requested.store(false, Ordering::SeqCst);

    let video_path = PathBuf::from(&options.video_path);
    if !video_path.is_file() {
        state.running.store(false, Ordering::SeqCst);
        return Err("Choose an existing video file first.".into());
    }
    let output_path = output_path_for(&video_path).map_err(|error| {
        state.running.store(false, Ordering::SeqCst);
        error
    })?;

    emit_status(
        &app,
        "running",
        "setup",
        "Checking the private runtime",
        Some(&output_path),
    );
    let app_for_run = app.clone();
    let output_for_run = output_path.clone();
    thread::spawn(move || {
        let state = app_for_run.state::<ConversionState>();
        let result = run_conversion(&app_for_run, &state, &options);
        state.running.store(false, Ordering::SeqCst);
        let _ = set_child_pid(&state, None);

        match result {
            Ok(()) => emit_status(
                &app_for_run,
                "complete",
                "complete",
                "Dialogue-only MP4 is ready",
                Some(&output_for_run),
            ),
            Err(error) => {
                emit_log(&app_for_run, "stderr", &error);
                emit_status(
                    &app_for_run,
                    "error",
                    "error",
                    &error,
                    Some(&output_for_run),
                );
            }
        }
    });

    Ok(output_path.display().to_string())
}

#[tauri::command]
fn stop_conversion(state: State<'_, ConversionState>) -> Result<(), String> {
    if !state.running.load(Ordering::SeqCst) {
        return Err("No conversion is running.".into());
    }
    state.cancel_requested.store(true, Ordering::SeqCst);
    if let Some(pid) = *state
        .child_pid
        .lock()
        .map_err(|_| "Process lock failed.")?
    {
        terminate_process(pid)?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ConversionState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_runtime_status,
            start_conversion,
            stop_conversion
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
