use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
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
const YT_DLP_PACKAGE: &str = "yt-dlp";

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SlowdownOptions {
    video_path: String,
    speed: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrabOptions {
    url: String,
    output_dir: String,
    download_video: bool,
    download_subtitles: bool,
    quality: String,
    subtitle_languages: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrabProbeOptions {
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrabQuality {
    value: String,
    label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrabSubtitleTrack {
    language: String,
    label: String,
    has_manual: bool,
    has_automatic: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrabMetadata {
    title: String,
    webpage_url: String,
    extractor: String,
    duration: Option<f64>,
    qualities: Vec<GrabQuality>,
    subtitles: Vec<GrabSubtitleTrack>,
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

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path = env::var_os("PATH")?;
    for directory in env::split_paths(&path) {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn local_media_tools_dir() -> PathBuf {
    find_on_path("ffmpeg")
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("/opt/homebrew/bin"))
}

fn local_processor_paths() -> ProcessorPaths {
    let tool_dir = local_tool_dir();
    ProcessorPaths {
        python: tool_dir.join(".dialogue-venv/bin/python"),
        venv_dir: tool_dir.join(".dialogue-venv"),
        script: tool_dir.join("dialogue-only.py"),
        tools_dir: local_media_tools_dir(),
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
        && media_tools_ready(paths)
}

fn media_tools_ready(paths: &ProcessorPaths) -> bool {
    paths.tools_dir.join("ffmpeg").is_file() && paths.tools_dir.join("ffprobe").is_file()
}

fn yt_dlp_ready(paths: &ProcessorPaths) -> bool {
    paths.python.is_file()
        && Command::new(&paths.python)
            .args(["-m", "yt_dlp", "--version"])
            .env("PYTHONNOUSERSITE", "1")
            .output()
            .is_ok_and(|output| output.status.success())
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

fn output_path_for_slowdown(video_path: &Path, speed: f64) -> Result<PathBuf, String> {
    let stem = video_path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or("The selected video filename is invalid.")?;
    Ok(video_path.with_file_name(format!("{stem}.slow-{speed:.2}x.mp4")))
}

fn output_template_for_grab(output_dir: &Path) -> PathBuf {
    output_dir.join("%(title).200B [%(id)s].%(ext)s")
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
    *state.child_pid.lock().map_err(|_| "Process lock failed.")? = pid;
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

fn run_captured_command(
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
    emit_log(
        app,
        "stdout",
        format!("Downloading {}...", destination.display()),
    );
    let mut command = Command::new("/usr/bin/curl");
    command
        .args([
            "--location",
            "--fail",
            "--show-error",
            "--progress-bar",
            "--output",
        ])
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

fn prepend_media_path(command: &mut Command, paths: &ProcessorPaths) {
    let inherited = env::var_os("PATH").unwrap_or_default();
    let mut entries = vec![paths.tools_dir.clone()];
    entries.extend(env::split_paths(&inherited));
    if let Ok(path) = env::join_paths(entries) {
        command.env("PATH", path);
    }
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
    command
        .args(["-xzf"])
        .arg(&archive)
        .arg("-C")
        .arg(&runtime_dir);
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

fn install_yt_dlp(
    app: &AppHandle,
    state: &ConversionState,
    paths: &ProcessorPaths,
) -> Result<(), String> {
    if yt_dlp_ready(paths) {
        return Ok(());
    }
    if !python_has_pip(paths) {
        emit_log(app, "stdout", "Installing pip into the private runtime...");
        let mut command = Command::new(&paths.python);
        command.args(["-m", "ensurepip", "--upgrade"]);
        prepend_runtime_path(&mut command, paths);
        run_logged_command(app, state, &mut command)?;
    }
    emit_log(app, "stdout", "Installing private yt-dlp downloader...");
    let mut command = Command::new(&paths.python);
    command.args([
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-warn-script-location",
        YT_DLP_PACKAGE,
    ]);
    prepend_runtime_path(&mut command, paths);
    run_logged_command(app, state, &mut command)?;
    if yt_dlp_ready(paths) {
        Ok(())
    } else {
        Err("yt-dlp was not installed into the private runtime.".into())
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

fn ensure_private_media_tools(
    app: &AppHandle,
    state: &ConversionState,
) -> Result<ProcessorPaths, String> {
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    return Err("This packaged build currently supports Apple Silicon Macs only.".into());

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let paths = private_processor_paths(app)?;
        if media_tools_ready(&paths) {
            return Ok(paths);
        }

        emit_status(
            app,
            "running",
            "setup",
            "Preparing private media tools",
            None,
        );
        install_static_tool(app, state, &paths, "ffmpeg", FFMPEG_URL, FFMPEG_SHA256)?;
        install_static_tool(app, state, &paths, "ffprobe", FFPROBE_URL, FFPROBE_SHA256)?;
        Ok(paths)
    }
}

fn ensure_private_download_tools(
    app: &AppHandle,
    state: &ConversionState,
) -> Result<ProcessorPaths, String> {
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    return Err("This packaged build currently supports Apple Silicon Macs only.".into());

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let paths = private_processor_paths(app)?;
        if paths.python.is_file() && media_tools_ready(&paths) && yt_dlp_ready(&paths) {
            return Ok(paths);
        }

        emit_status(app, "running", "setup", "Preparing downloader", None);
        emit_runtime_status(
            app,
            false,
            "Installing private downloader. First setup can take a few minutes.",
        );
        let data_dir = app_data_dir(app)?;
        install_python(app, state, &paths, &data_dir)?;
        install_static_tool(app, state, &paths, "ffmpeg", FFMPEG_URL, FFMPEG_SHA256)?;
        install_static_tool(app, state, &paths, "ffprobe", FFPROBE_URL, FFPROBE_SHA256)?;
        install_yt_dlp(app, state, &paths)?;
        emit_runtime_status(app, true, "Private downloader is installed");
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

fn media_paths(app: &AppHandle, state: &ConversionState) -> Result<ProcessorPaths, String> {
    let local = local_processor_paths();
    if cfg!(debug_assertions) && media_tools_ready(&local) {
        return Ok(local);
    }
    ensure_private_media_tools(app, state)
}

enum DownloadRunner {
    Binary {
        binary: PathBuf,
        paths: ProcessorPaths,
    },
    PythonModule {
        paths: ProcessorPaths,
    },
}

fn download_runner(app: &AppHandle, state: &ConversionState) -> Result<DownloadRunner, String> {
    if cfg!(debug_assertions) {
        if let Some(binary) = find_on_path("yt-dlp") {
            return Ok(DownloadRunner::Binary {
                binary,
                paths: media_paths(app, state)?,
            });
        }
    }

    Ok(DownloadRunner::PythonModule {
        paths: ensure_private_download_tools(app, state)?,
    })
}

fn atempo_filter(speed: f64) -> String {
    let mut remaining = speed;
    let mut factors = Vec::new();
    while remaining < 0.5 {
        factors.push(0.5);
        remaining /= 0.5;
    }
    while remaining > 2.0 {
        factors.push(2.0);
        remaining /= 2.0;
    }
    factors.push(remaining);
    factors
        .into_iter()
        .map(|factor| format!("atempo={factor:.5}"))
        .collect::<Vec<_>>()
        .join(",")
}

fn subtitle_language_spec(raw: &str) -> String {
    raw.split(',')
        .map(str::trim)
        .filter(|language| !language.is_empty())
        .collect::<Vec<_>>()
        .join(",")
}

fn format_selector_for_quality(raw: &str) -> String {
    let quality = raw.trim();
    if quality == "best" {
        return "bv*+ba/b".into();
    }

    let max_height = quality.parse::<u32>().unwrap_or(1080);
    format!("bv*[height<={max_height}]+ba/b[height<={max_height}]/b")
}

fn string_field(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn collect_qualities(value: &serde_json::Value) -> Vec<GrabQuality> {
    let mut heights = BTreeSet::new();
    if let Some(formats) = value.get("formats").and_then(serde_json::Value::as_array) {
        for format in formats {
            let has_video = format
                .get("vcodec")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|codec| codec != "none");
            if !has_video {
                continue;
            }
            if let Some(height) = format.get("height").and_then(serde_json::Value::as_u64) {
                if (144..=4320).contains(&height) {
                    heights.insert(height);
                }
            }
        }
    }

    let mut qualities = vec![GrabQuality {
        value: "best".into(),
        label: "Best available".into(),
    }];
    qualities.extend(heights.iter().rev().map(|height| GrabQuality {
        value: height.to_string(),
        label: format!("{height}p or lower"),
    }));
    qualities
}

fn collect_subtitle_group(
    value: &serde_json::Value,
    key: &str,
    label: &str,
    tracks: &mut BTreeMap<String, BTreeSet<String>>,
) {
    let Some(group) = value.get(key).and_then(serde_json::Value::as_object) else {
        return;
    };
    for language in group.keys() {
        if language == "live_chat" || language.starts_with("live_chat") {
            continue;
        }
        tracks
            .entry(language.to_string())
            .or_default()
            .insert(label.into());
    }
}

fn collect_subtitles(value: &serde_json::Value) -> Vec<GrabSubtitleTrack> {
    let mut tracks = BTreeMap::new();
    collect_subtitle_group(value, "subtitles", "manual", &mut tracks);
    collect_subtitle_group(value, "automatic_captions", "auto", &mut tracks);

    let mut subtitles = tracks
        .into_iter()
        .map(|(language, sources)| {
            let has_manual = sources.contains("manual");
            let has_automatic = sources.contains("auto");
            let source_label = match (has_manual, has_automatic) {
                (true, true) => "manual + auto",
                (true, false) => "manual",
                (false, true) => "auto",
                (false, false) => "unknown",
            };
            GrabSubtitleTrack {
                label: format!("{language} ({source_label})"),
                language,
                has_manual,
                has_automatic,
            }
        })
        .collect::<Vec<_>>();

    subtitles.sort_by_key(|track| {
        let priority = match track.language.as_str() {
            "de" => 0,
            "en" => 1,
            _ => 2,
        };
        (priority, track.language.clone())
    });
    subtitles
}

fn parse_grab_metadata(stdout: &str) -> Result<GrabMetadata, String> {
    let value: serde_json::Value = serde_json::from_str(stdout)
        .map_err(|error| format!("Could not parse yt-dlp metadata: {error}"))?;
    let title = string_field(&value, "title");
    Ok(GrabMetadata {
        title: if title.is_empty() {
            "Untitled video".into()
        } else {
            title
        },
        webpage_url: string_field(&value, "webpage_url"),
        extractor: string_field(&value, "extractor"),
        duration: value.get("duration").and_then(serde_json::Value::as_f64),
        qualities: collect_qualities(&value),
        subtitles: collect_subtitles(&value),
    })
}

fn add_probe_args(command: &mut Command, url: &str) {
    command
        .args([
            "--ignore-config",
            "--no-playlist",
            "--skip-download",
            "--dump-single-json",
        ])
        .arg(url.trim());
}

fn add_grab_args(
    command: &mut Command,
    options: &GrabOptions,
    output_template: &Path,
    tools_dir: &Path,
) {
    command
        .args([
            "--ignore-config",
            "--newline",
            "--no-playlist",
            "--restrict-filenames",
            "--windows-filenames",
        ])
        .arg("--ffmpeg-location")
        .arg(tools_dir)
        .arg("-o")
        .arg(output_template);

    if options.download_video {
        let format_selector = format_selector_for_quality(&options.quality);
        command
            .args(["-f", &format_selector])
            .args(["-S", "res,vcodec:h264,acodec:m4a"])
            .args(["--merge-output-format", "mp4"])
            .args(["--remux-video", "mp4"]);
    } else {
        command.arg("--skip-download");
    }

    if options.download_subtitles {
        let languages = subtitle_language_spec(&options.subtitle_languages);
        command
            .arg("--write-subs")
            .arg("--write-auto-subs")
            .args(["--sub-langs", &languages])
            .args(["--sub-format", "srt/vtt/best"])
            .args(["--convert-subs", "srt"])
            .args(["--sleep-subtitles", "1"]);
    }

    command.arg(options.url.trim());
}

fn probe_grab_inner(
    app: &AppHandle,
    state: &ConversionState,
    options: &GrabProbeOptions,
) -> Result<GrabMetadata, String> {
    let runner = download_runner(app, state)?;
    emit_status(app, "running", "fetch", "Fetching material metadata", None);

    let stdout = match runner {
        DownloadRunner::Binary { binary, paths } => {
            let mut command = Command::new(binary);
            add_probe_args(&mut command, &options.url);
            prepend_media_path(&mut command, &paths);
            run_captured_command(app, state, &mut command)?
        }
        DownloadRunner::PythonModule { paths } => {
            let mut command = Command::new(&paths.python);
            command.args(["-m", "yt_dlp"]);
            add_probe_args(&mut command, &options.url);
            prepend_runtime_path(&mut command, &paths);
            run_captured_command(app, state, &mut command)?
        }
    };

    parse_grab_metadata(&stdout)
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

fn run_slowdown(
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
    let ffmpeg = paths.tools_dir.join("ffmpeg");
    if !ffmpeg.is_file() {
        return Err(format!("ffmpeg not found at {}.", ffmpeg.display()));
    }

    emit_status(
        app,
        "running",
        "inspect",
        "Inspecting the selected video",
        Some(output_path),
    );
    emit_status(
        app,
        "running",
        "transcode",
        "Transcoding slowed video and audio",
        Some(output_path),
    );

    let video_filter = format!("setpts=PTS/{:.5},format=yuv420p", options.speed);
    let audio_filter = atempo_filter(options.speed);
    let mut command = Command::new(ffmpeg);
    command
        .arg("-hide_banner")
        .arg("-y")
        .arg("-i")
        .arg(&video_path)
        .args(["-map", "0:v:0"])
        .args(["-map", "0:a:0"])
        .arg("-sn")
        .args(["-vf", &video_filter])
        .args(["-af", &audio_filter])
        .args(["-c:v", "libx264"])
        .args(["-preset", "veryfast"])
        .args(["-crf", "22"])
        .args(["-pix_fmt", "yuv420p"])
        .args(["-profile:v", "high"])
        .args(["-c:a", "aac"])
        .args(["-b:a", "192k"])
        .args(["-movflags", "+faststart"])
        .arg(output_path);
    prepend_media_path(&mut command, &paths);
    run_logged_command(app, state, &mut command)
}

fn run_grab(
    app: &AppHandle,
    state: &ConversionState,
    options: &GrabOptions,
    output_dir: &Path,
) -> Result<(), String> {
    fs::create_dir_all(output_dir)
        .map_err(|error| format!("Could not create {}: {error}", output_dir.display()))?;
    let output_template = output_template_for_grab(output_dir);
    let runner = download_runner(app, state)?;

    let phase = if options.download_video {
        "download"
    } else {
        "subtitles"
    };
    let message = if options.download_video {
        "Downloading selected material"
    } else {
        "Saving selected subtitles"
    };
    emit_status(app, "running", phase, message, Some(output_dir));

    match runner {
        DownloadRunner::Binary { binary, paths } => {
            let mut command = Command::new(binary);
            add_grab_args(&mut command, options, &output_template, &paths.tools_dir);
            prepend_media_path(&mut command, &paths);
            run_logged_command(app, state, &mut command)
        }
        DownloadRunner::PythonModule { paths } => {
            let mut command = Command::new(&paths.python);
            command.args(["-m", "yt_dlp"]);
            add_grab_args(&mut command, options, &output_template, &paths.tools_dir);
            prepend_runtime_path(&mut command, &paths);
            run_logged_command(app, state, &mut command)
        }
    }
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
fn start_slowdown(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: SlowdownOptions,
) -> Result<String, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A process is already running.".into());
    }
    state.cancel_requested.store(false, Ordering::SeqCst);

    let video_path = PathBuf::from(&options.video_path);
    if !video_path.is_file() {
        state.running.store(false, Ordering::SeqCst);
        return Err("Choose an existing video file first.".into());
    }
    let output_path = output_path_for_slowdown(&video_path, options.speed).map_err(|error| {
        state.running.store(false, Ordering::SeqCst);
        error
    })?;

    emit_status(
        &app,
        "running",
        "setup",
        "Checking media tools",
        Some(&output_path),
    );
    let app_for_run = app.clone();
    let output_for_run = output_path.clone();
    thread::spawn(move || {
        let state = app_for_run.state::<ConversionState>();
        let result = run_slowdown(&app_for_run, &state, &options, &output_for_run);
        state.running.store(false, Ordering::SeqCst);
        let _ = set_child_pid(&state, None);

        match result {
            Ok(()) => emit_status(
                &app_for_run,
                "complete",
                "complete",
                "Slowed MP4 is ready",
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
fn probe_grab(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: GrabProbeOptions,
) -> Result<GrabMetadata, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A process is already running.".into());
    }
    state.cancel_requested.store(false, Ordering::SeqCst);

    let url = options.url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        state.running.store(false, Ordering::SeqCst);
        return Err("Enter a valid http or https URL first.".into());
    }

    emit_status(&app, "running", "setup", "Checking downloader tools", None);
    let result = probe_grab_inner(&app, &state, &options);
    state.running.store(false, Ordering::SeqCst);
    let _ = set_child_pid(&state, None);

    match result {
        Ok(metadata) => {
            emit_status(&app, "complete", "fetch", "Metadata is ready", None);
            Ok(metadata)
        }
        Err(error) => {
            emit_log(&app, "stderr", &error);
            emit_status(&app, "error", "error", &error, None);
            Err(error)
        }
    }
}

#[tauri::command]
fn start_grab(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: GrabOptions,
) -> Result<String, String> {
    if state.running.swap(true, Ordering::SeqCst) {
        return Err("A process is already running.".into());
    }
    state.cancel_requested.store(false, Ordering::SeqCst);

    let url = options.url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        state.running.store(false, Ordering::SeqCst);
        return Err("Enter a valid http or https URL first.".into());
    }
    if !options.download_video && !options.download_subtitles {
        state.running.store(false, Ordering::SeqCst);
        return Err("Choose video, subtitles, or both.".into());
    }
    if options.download_subtitles && subtitle_language_spec(&options.subtitle_languages).is_empty()
    {
        state.running.store(false, Ordering::SeqCst);
        return Err("Choose at least one subtitle track.".into());
    }
    let output_dir = PathBuf::from(options.output_dir.trim());
    if output_dir.as_os_str().is_empty() {
        state.running.store(false, Ordering::SeqCst);
        return Err("Choose an output folder first.".into());
    }

    emit_status(
        &app,
        "running",
        "setup",
        "Checking downloader tools",
        Some(&output_dir),
    );
    let app_for_run = app.clone();
    let output_for_run = output_dir.clone();
    thread::spawn(move || {
        let state = app_for_run.state::<ConversionState>();
        let result = run_grab(&app_for_run, &state, &options, &output_for_run);
        state.running.store(false, Ordering::SeqCst);
        let _ = set_child_pid(&state, None);

        match result {
            Ok(()) => emit_status(
                &app_for_run,
                "complete",
                "complete",
                "Material is ready",
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

    Ok(output_dir.display().to_string())
}

#[tauri::command]
fn stop_conversion(state: State<'_, ConversionState>) -> Result<(), String> {
    if !state.running.load(Ordering::SeqCst) {
        return Err("No conversion is running.".into());
    }
    state.cancel_requested.store(true, Ordering::SeqCst);
    if let Some(pid) = *state.child_pid.lock().map_err(|_| "Process lock failed.")? {
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
            start_slowdown,
            probe_grab,
            start_grab,
            stop_conversion
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
