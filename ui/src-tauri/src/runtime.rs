//! Tool and runtime provisioning: where python/ffmpeg/whisper/yt-dlp live,
//! and how the private runtime gets downloaded and installed on first use.

use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager};

use crate::events::{emit_log, emit_runtime_status, emit_status, RuntimeStatus};
use crate::process::{run_logged_command, ConversionState};

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

pub(crate) struct ProcessorPaths {
    pub(crate) python: PathBuf,
    pub(crate) venv_dir: PathBuf,
    pub(crate) script: PathBuf,
    pub(crate) tools_dir: PathBuf,
    pub(crate) hf_home: PathBuf,
}

fn local_tool_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub(crate) fn find_on_path(name: &str) -> Option<PathBuf> {
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

pub(crate) fn dirs_home() -> PathBuf {
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

pub(crate) fn runtime_status_inner(app: &AppHandle) -> RuntimeStatus {
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

pub(crate) fn prepend_runtime_path(command: &mut Command, paths: &ProcessorPaths) {
    let inherited = env::var_os("PATH").unwrap_or_default();
    let mut entries = vec![paths.tools_dir.clone(), paths.venv_dir.join("bin")];
    entries.extend(env::split_paths(&inherited));
    if let Ok(path) = env::join_paths(entries) {
        command.env("PATH", path);
    }
    command
        .env("HF_HOME", &paths.hf_home)
        .env("PYTHONNOUSERSITE", "1")
        // Stream tool output line-by-line through our pipes instead of in
        // 8 KB blocks; live logs and progress depend on it.
        .env("PYTHONUNBUFFERED", "1");
}

pub(crate) fn prepend_media_path(command: &mut Command, paths: &ProcessorPaths) {
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

fn ensure_pip(
    app: &AppHandle,
    state: &ConversionState,
    paths: &ProcessorPaths,
) -> Result<(), String> {
    if python_has_pip(paths) {
        return Ok(());
    }
    emit_log(app, "stdout", "Installing pip into the private runtime...");
    let mut command = Command::new(&paths.python);
    command.args(["-m", "ensurepip", "--upgrade"]);
    prepend_runtime_path(&mut command, paths);
    run_logged_command(app, state, &mut command)
}

fn pip_install(
    app: &AppHandle,
    state: &ConversionState,
    paths: &ProcessorPaths,
    package: &str,
) -> Result<(), String> {
    ensure_pip(app, state, paths)?;
    let mut command = Command::new(&paths.python);
    command.args([
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-warn-script-location",
        package,
    ]);
    prepend_runtime_path(&mut command, paths);
    run_logged_command(app, state, &mut command)
}

fn install_whisper(
    app: &AppHandle,
    state: &ConversionState,
    paths: &ProcessorPaths,
) -> Result<(), String> {
    if paths.venv_dir.join("bin/mlx_whisper").is_file() {
        return Ok(());
    }
    emit_log(
        app,
        "stdout",
        "Installing the private Whisper runtime. This is the longest first-run step...",
    );
    pip_install(app, state, paths, MLX_WHISPER_PACKAGE)?;
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
    emit_log(app, "stdout", "Installing private yt-dlp downloader...");
    pip_install(app, state, paths, YT_DLP_PACKAGE)?;
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

pub(crate) fn ensure_private_download_tools(
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

/// Resolves the same paths as processor_paths, but never installs anything.
/// For read-only checks like listing downloaded models.
pub(crate) fn probe_processor_paths(app: &AppHandle) -> Result<ProcessorPaths, String> {
    let local = local_processor_paths();
    if cfg!(debug_assertions) && local_runtime_ready(&local) {
        return Ok(local);
    }
    private_processor_paths(app)
}

pub(crate) fn processor_paths(
    app: &AppHandle,
    state: &ConversionState,
) -> Result<ProcessorPaths, String> {
    let local = local_processor_paths();
    if cfg!(debug_assertions) && local_runtime_ready(&local) {
        return Ok(local);
    }
    ensure_private_runtime(app, state)
}

pub(crate) fn media_paths(
    app: &AppHandle,
    state: &ConversionState,
) -> Result<ProcessorPaths, String> {
    let local = local_processor_paths();
    if cfg!(debug_assertions) && media_tools_ready(&local) {
        return Ok(local);
    }
    ensure_private_media_tools(app, state)
}
