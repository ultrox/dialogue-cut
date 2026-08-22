//! Tool and runtime provisioning: where python/ffmpeg/whisper/yt-dlp live,
//! and how the private runtime gets downloaded and installed on first use.

use serde::Serialize;
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
// `default` supplies the matching EJS challenge scripts; `deno` supplies the
// supported JavaScript runtime YouTube extraction now requires. Keeping both
// in the managed Python environment avoids relying on a Homebrew installation.
const YT_DLP_PACKAGE: &str = "yt-dlp[default,deno]";
const YT_DLP_POT_VERSION: &str = "1.3.2";
const YT_DLP_POT_PACKAGE: &str = "bgutil-ytdlp-pot-provider==1.3.2";
const YT_DLP_POT_ARCHIVE: &str = "bgutil-ytdlp-pot-provider-1.3.2.tar.gz";
const YT_DLP_POT_URL: &str =
    "https://github.com/Brainicism/bgutil-ytdlp-pot-provider/archive/refs/tags/1.3.2.tar.gz";
const YT_DLP_POT_SHA256: &str = "3545ac7ffc0869498755cb3b4760a72fa2f176689d0890a6f5b898d163012ba2";
const YT_DLP_PYPI_URL: &str = "https://pypi.org/pypi/yt-dlp/json";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DownloaderStatus {
    installed: bool,
    outdated: bool,
    repair_needed: bool,
    installed_version: Option<String>,
    latest_version: Option<String>,
    message: String,
}

pub(crate) struct ProcessorPaths {
    pub(crate) python: PathBuf,
    pub(crate) venv_dir: PathBuf,
    pub(crate) script: PathBuf,
    pub(crate) tools_dir: PathBuf,
    pub(crate) hf_home: PathBuf,
    pub(crate) yt_dlp_pot_server: PathBuf,
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
        yt_dlp_pot_server: tool_dir.join(".dialogue-bgutil/server"),
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
        yt_dlp_pot_server: data_dir.join("runtime/bgutil/server"),
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

fn installed_yt_dlp_version(paths: &ProcessorPaths) -> Option<String> {
    if !paths.python.is_file() {
        return None;
    }
    let output = Command::new(&paths.python)
        .args(["-m", "yt_dlp", "--version"])
        .env("PYTHONNOUSERSITE", "1")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!version.is_empty()).then_some(version)
}

fn yt_dlp_ready(paths: &ProcessorPaths) -> bool {
    installed_yt_dlp_version(paths).is_some() && yt_dlp_support_ready(paths)
}

fn yt_dlp_pot_server_ready(paths: &ProcessorPaths) -> bool {
    paths
        .yt_dlp_pot_server
        .join("src/generate_once.ts")
        .is_file()
        && paths.yt_dlp_pot_server.join("node_modules").is_dir()
        && fs::read_to_string(paths.yt_dlp_pot_server.join(".installed-version"))
            .is_ok_and(|version| version == YT_DLP_POT_VERSION)
}

fn yt_dlp_support_ready(paths: &ProcessorPaths) -> bool {
    let python_support_ready = Command::new(&paths.python)
        .args([
            "-c",
            "import yt_dlp_ejs, yt_dlp_plugins.extractor.getpot_bgutil_script",
        ])
        .env("PYTHONNOUSERSITE", "1")
        .output()
        .is_ok_and(|output| output.status.success());
    let deno_ready = Command::new(paths.venv_dir.join("bin/deno"))
        .arg("--version")
        .output()
        .is_ok_and(|output| output.status.success());
    python_support_ready && deno_ready && yt_dlp_pot_server_ready(paths)
}

fn latest_yt_dlp_version() -> Result<String, String> {
    let output = Command::new("/usr/bin/curl")
        .args([
            "--location",
            "--fail",
            "--silent",
            "--show-error",
            "--max-time",
            "8",
            YT_DLP_PYPI_URL,
        ])
        .output()
        .map_err(|error| format!("Could not check the latest yt-dlp version: {error}"))?;
    if !output.status.success() {
        return Err("Could not check the latest yt-dlp version.".into());
    }
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Could not read the latest yt-dlp version: {error}"))?;
    value
        .pointer("/info/version")
        .and_then(serde_json::Value::as_str)
        .filter(|version| !version.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| "PyPI did not report a yt-dlp version.".into())
}

fn release_version(version: &str) -> Option<[u32; 3]> {
    let mut parts = version.split('.');
    Some([
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    ])
}

fn version_is_older(installed: &str, latest: &str) -> bool {
    match (release_version(installed), release_version(latest)) {
        (Some(installed), Some(latest)) => installed < latest,
        _ => false,
    }
}

pub(crate) fn downloader_status_inner(app: &AppHandle) -> Result<DownloaderStatus, String> {
    let paths = private_processor_paths(app)?;
    let installed_version = installed_yt_dlp_version(&paths);
    let latest_version = latest_yt_dlp_version().ok();
    let support_ready = installed_version.is_some() && yt_dlp_support_ready(&paths);
    let release_outdated = installed_version
        .as_deref()
        .zip(latest_version.as_deref())
        .is_some_and(|(installed, latest)| version_is_older(installed, latest));
    let outdated = installed_version.is_some() && release_outdated;
    let repair_needed = installed_version.is_some() && !support_ready;
    let message = if let Some(installed) = &installed_version {
        if repair_needed && release_outdated {
            let latest = latest_version.as_deref().unwrap_or_default();
            format!(
                "yt-dlp {installed} is outdated and its YouTube support needs repair. Update to {latest} to continue."
            )
        } else if repair_needed {
            format!(
                "yt-dlp {installed} is installed, but its YouTube support needs repair. Repair it to continue."
            )
        } else if release_outdated {
            let latest = latest_version.as_deref().unwrap_or_default();
            format!("yt-dlp {installed} is outdated. Update to {latest} to continue.")
        } else if latest_version.is_some() {
            format!("yt-dlp {installed} is ready.")
        } else {
            format!("yt-dlp {installed} is installed. The update check is unavailable.")
        }
    } else if let Some(latest) = &latest_version {
        format!("Not installed. Version {latest} downloads automatically on first scan.")
    } else {
        "Not installed. yt-dlp downloads automatically on first scan.".into()
    };
    Ok(DownloaderStatus {
        installed: installed_version.is_some(),
        outdated,
        repair_needed,
        installed_version,
        latest_version,
        message,
    })
}

fn require_current_yt_dlp(paths: &ProcessorPaths) -> Result<(), String> {
    let Some(installed) = installed_yt_dlp_version(paths) else {
        return Ok(());
    };
    if !yt_dlp_support_ready(paths) {
        return Err(format!(
            "yt-dlp {installed} is missing current YouTube support. Repair it in Material Grabber before continuing."
        ));
    }
    let Ok(latest) = latest_yt_dlp_version() else {
        // An unavailable update service must not make an installed downloader
        // unusable offline. The UI reports that it could not check.
        return Ok(());
    };
    if version_is_older(&installed, &latest) {
        Err(format!(
            "yt-dlp {installed} is outdated. Update to {latest} in Material Grabber before continuing."
        ))
    } else {
        Ok(())
    }
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
    upgrade: bool,
) -> Result<(), String> {
    ensure_pip(app, state, paths)?;
    let mut command = Command::new(&paths.python);
    command.args([
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-warn-script-location",
    ]);
    if upgrade {
        command.arg("--upgrade");
    }
    command.arg(package);
    prepend_runtime_path(&mut command, paths);
    run_logged_command(app, state, &mut command)
}

fn pip_uninstall(
    app: &AppHandle,
    state: &ConversionState,
    paths: &ProcessorPaths,
    package: &str,
) -> Result<(), String> {
    let mut command = Command::new(&paths.python);
    command.args(["-m", "pip", "uninstall", "--yes", package]);
    prepend_runtime_path(&mut command, paths);
    run_logged_command(app, state, &mut command)
}

fn install_yt_dlp_pot_server(
    app: &AppHandle,
    state: &ConversionState,
    paths: &ProcessorPaths,
    data_dir: &Path,
) -> Result<(), String> {
    if yt_dlp_pot_server_ready(paths) {
        return Ok(());
    }

    let archive = data_dir.join("downloads").join(YT_DLP_POT_ARCHIVE);
    download_verified(app, state, YT_DLP_POT_URL, YT_DLP_POT_SHA256, &archive)?;
    let install_dir = paths
        .yt_dlp_pot_server
        .parent()
        .ok_or("Could not locate the bgutil install directory.")?;
    let _ = fs::remove_dir_all(install_dir);
    fs::create_dir_all(install_dir)
        .map_err(|error| format!("Could not create {}: {error}", install_dir.display()))?;

    emit_log(
        app,
        "stdout",
        "Extracting non-browser YouTube token support...",
    );
    let mut extract = Command::new("/usr/bin/tar");
    extract
        .args(["-xzf"])
        .arg(&archive)
        .arg("-C")
        .arg(install_dir)
        .args(["--strip-components", "1"]);
    run_logged_command(app, state, &mut extract)?;

    emit_log(
        app,
        "stdout",
        "Preparing non-browser YouTube token support...",
    );
    let mut install = Command::new(paths.venv_dir.join("bin/deno"));
    install
        .args(["install", "--allow-scripts=npm:canvas", "--frozen"])
        .current_dir(&paths.yt_dlp_pot_server);
    prepend_runtime_path(&mut install, paths);
    run_logged_command(app, state, &mut install)?;

    let mut version = Command::new(paths.venv_dir.join("bin/deno"));
    let cache_dir = dirs_home().join(".cache/bgutil-ytdlp-pot-provider");
    version
        .args(["run", "--allow-env", "--allow-net"])
        .arg(format!(
            "--allow-ffi={}",
            paths.yt_dlp_pot_server.join("node_modules").display()
        ))
        .arg(format!("--allow-write={}", cache_dir.display()))
        .arg(format!(
            "--allow-read={},{}",
            cache_dir.display(),
            paths.yt_dlp_pot_server.join("node_modules").display()
        ))
        .args(["src/generate_once.ts", "--version"])
        .current_dir(&paths.yt_dlp_pot_server)
        .env("DENO_NO_PROMPT", "1")
        .env("DENO_NO_UPDATE_CHECK", "1");
    prepend_runtime_path(&mut version, paths);
    let output = version
        .output()
        .map_err(|error| format!("Could not verify YouTube token support: {error}"))?;
    let installed = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && installed == YT_DLP_POT_VERSION {
        fs::write(
            paths.yt_dlp_pot_server.join(".installed-version"),
            YT_DLP_POT_VERSION,
        )
        .map_err(|error| format!("Could not record YouTube token support version: {error}"))
    } else {
        Err(format!(
            "YouTube token support {YT_DLP_POT_VERSION} could not start (reported {installed:?})."
        ))
    }
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
    pip_install(app, state, paths, MLX_WHISPER_PACKAGE, false)?;
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
    upgrade: bool,
) -> Result<(), String> {
    if !upgrade && yt_dlp_ready(paths) {
        return Ok(());
    }
    emit_log(
        app,
        "stdout",
        if upgrade {
            "Updating or repairing the private yt-dlp downloader..."
        } else {
            "Installing the private yt-dlp downloader..."
        },
    );
    pip_install(app, state, paths, YT_DLP_PACKAGE, upgrade)?;
    pip_install(app, state, paths, YT_DLP_POT_PACKAGE, upgrade)?;
    // Older downloader installs used WPC, whose fallback launches Chrome.
    pip_uninstall(app, state, paths, "yt-dlp-getpot-wpc")?;
    let data_dir = app_data_dir(app)?;
    install_yt_dlp_pot_server(app, state, paths, &data_dir)?;
    if yt_dlp_ready(paths) {
        Ok(())
    } else {
        Err("yt-dlp was installed, but its YouTube support could not start.".into())
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
        if installed_yt_dlp_version(&paths).is_some() {
            require_current_yt_dlp(&paths)?;
        }
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
        install_yt_dlp(app, state, &paths, false)?;
        require_current_yt_dlp(&paths)?;
        emit_runtime_status(app, true, "Private downloader is installed");
        Ok(paths)
    }
}

pub(crate) fn run_downloader_install(
    app: &AppHandle,
    state: &ConversionState,
) -> Result<(), String> {
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    return Err("This packaged build currently supports Apple Silicon Macs only.".into());

    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let paths = private_processor_paths(app)?;
        let data_dir = app_data_dir(app)?;
        emit_status(app, "running", "setup", "Preparing downloader", None);
        install_python(app, state, &paths, &data_dir)?;
        install_yt_dlp(app, state, &paths, true)?;
        require_current_yt_dlp(&paths)?;
        emit_runtime_status(app, true, "Private downloader is installed");
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::{release_version, version_is_older};

    #[test]
    fn parses_zero_padded_and_pypi_release_versions() {
        assert_eq!(release_version("2026.07.04"), Some([2026, 7, 4]));
        assert_eq!(release_version("2026.7.4"), Some([2026, 7, 4]));
    }

    #[test]
    fn detects_older_calendar_releases() {
        assert!(version_is_older("2026.03.17", "2026.7.4"));
        assert!(!version_is_older("2026.07.04", "2026.7.4"));
        assert!(!version_is_older("2026.08.01", "2026.7.4"));
    }

    #[test]
    fn unknown_version_schemes_do_not_block_the_downloader() {
        assert!(!version_is_older("nightly", "2026.7.4"));
    }
}
