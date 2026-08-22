//! Tauri command layer. Each command validates its input, then hands off to
//! the matching domain module:
//!
//! - events     — payloads and emit helpers for everything the UI listens to
//! - process    — job slot, cancellation, child-process runners
//! - runtime    — tool/runtime provisioning (python, ffmpeg, whisper, yt-dlp)
//! - media      — ffmpeg/ffprobe wrappers and recipes
//! - dialogue, slowdown, convert, audio_video, merge, transcribe, grabber — one module per workflow
//! - gallery    — material video listing

mod audio_video;
mod convert;
mod dialogue;
mod events;
mod export;
mod gallery;
mod grabber;
mod media;
mod media_server;
mod merge;
mod player;
mod process;
mod runtime;
mod slowdown;
mod transcribe;

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::Ordering,
};
use tauri::{AppHandle, State};

use audio_video::{
    image_path_for_audio_video, output_path_for_audio_video, run_audio_video, AudioVideoOptions,
};
use convert::{output_path_for_convert, run_convert, ConvertOptions};
use dialogue::{output_path_for, run_conversion, ConversionOptions};
use events::{emit_log, emit_status, RuntimeStatus};
use export::{output_path_for_export, run_export, ExportOptions};
use gallery::{list_material_videos_inner, MaterialGalleryOptions, MaterialVideo};
use grabber::{
    default_grab_output_dir, delete_grab_text_file_inner, list_grab_text_files_inner,
    probe_grab_inner, read_grab_text_file_inner, render_chapters, run_grab, GrabChapter,
    GrabMetadata, GrabOptions, GrabProbeOptions, GrabTextFile,
};
use merge::{output_path_for_merge, run_merge, validated_media_paths, MergeOptions};
use player::{
    IgnoreLoadOptions, IgnoreSaveOptions, SubtitleFile, SubtitleListOptions, SubtitleReadOptions,
};
use process::{
    existing_file, set_child_pid, start_background_job, terminate_process, ConversionState,
};
use runtime::{
    downloader_status_inner, probe_processor_paths, run_downloader_install, runtime_status_inner,
    DownloaderStatus,
};
use slowdown::{output_path_for_slowdown, run_slowdown, SlowdownOptions};
use transcribe::{
    delete_model, list_models, model_cache_dir, normalized_formats, run_model_download,
    run_transcribe, transcript_base_name, validated_model, ModelDownloadOptions, TranscribeOptions,
    WhisperModelInfo,
};

#[tauri::command]
fn get_runtime_status(app: AppHandle) -> RuntimeStatus {
    runtime_status_inner(&app)
}

#[tauri::command]
fn get_downloader_status(app: AppHandle) -> Result<DownloaderStatus, String> {
    downloader_status_inner(&app)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloaderInstallOptions {
    output_dir: String,
}

#[tauri::command]
fn start_downloader_install(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: DownloaderInstallOptions,
) -> Result<String, String> {
    let output_path = if options.output_dir.trim().is_empty() {
        default_grab_output_dir()
    } else {
        PathBuf::from(options.output_dir.trim())
    };
    start_background_job(
        app,
        &state,
        "Preparing the downloader",
        "Downloader is ready",
        output_path,
        run_downloader_install,
    )
}

#[tauri::command]
fn start_conversion(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: ConversionOptions,
) -> Result<String, String> {
    let video_path = existing_file(&options.video_path)?;
    let output_path = output_path_for(&video_path)?;
    start_background_job(
        app,
        &state,
        "Checking the private runtime",
        "Dialogue-only MP4 is ready",
        output_path,
        move |app, state| run_conversion(app, state, &options),
    )
}

#[tauri::command]
fn start_slowdown(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: SlowdownOptions,
) -> Result<String, String> {
    let video_path = existing_file(&options.video_path)?;
    let output_path = output_path_for_slowdown(&video_path, options.speed)?;
    let worker_output = output_path.clone();
    start_background_job(
        app,
        &state,
        "Checking media tools",
        "Slowed MP4 is ready",
        output_path,
        move |app, state| run_slowdown(app, state, &options, &worker_output),
    )
}

#[tauri::command]
fn start_convert(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: ConvertOptions,
) -> Result<String, String> {
    let video_path = existing_file(&options.video_path)?;
    let output_path = output_path_for_convert(&video_path)?;
    let worker_output = output_path.clone();
    start_background_job(
        app,
        &state,
        "Checking media tools",
        "Converted MP4 is ready",
        output_path,
        move |app, state| run_convert(app, state, &options, &worker_output),
    )
}

#[tauri::command]
fn start_merge(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: MergeOptions,
) -> Result<String, String> {
    let media_paths = validated_media_paths(&options.media_paths)?;
    let output_path = output_path_for_merge(&media_paths, &options.output_path)?;
    let worker_output = output_path.clone();
    start_background_job(
        app,
        &state,
        "Checking media tools",
        "Merged media is ready",
        output_path,
        move |app, state| run_merge(app, state, &options, &worker_output),
    )
}

#[tauri::command]
fn start_audio_video(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: AudioVideoOptions,
) -> Result<String, String> {
    let audio_path = existing_file(&options.audio_path)?;
    let output_path = output_path_for_audio_video(&audio_path, &options.output_path)?;
    if image_path_for_audio_video(&options.image_path)?.as_deref() == Some(output_path.as_path()) {
        return Err("The video output cannot overwrite the selected image file.".into());
    }
    let worker_output = output_path.clone();
    start_background_job(
        app,
        &state,
        "Checking media tools",
        "Audio video is ready",
        output_path,
        move |app, state| run_audio_video(app, state, &options, &worker_output),
    )
}

#[tauri::command]
fn start_transcribe(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: TranscribeOptions,
) -> Result<String, String> {
    let video_path = existing_file(&options.video_path)?;
    let base_name = transcript_base_name(&video_path, &options.language)?;
    let formats = normalized_formats(&options.formats)?;
    let output_path = video_path.with_file_name(format!("{base_name}.{}", formats[0]));
    start_background_job(
        app,
        &state,
        "Checking the private runtime",
        "Transcription files are ready",
        output_path,
        move |app, state| run_transcribe(app, state, &options, &base_name),
    )
}

#[tauri::command]
fn start_dialogue_export(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: ExportOptions,
) -> Result<String, String> {
    let video_path = existing_file(&options.video_path)?;
    let output_path = output_path_for_export(&video_path)?;
    let worker_output = output_path.clone();
    start_background_job(
        app,
        &state,
        "Checking media tools",
        "Dialogue cut is ready",
        output_path,
        move |app, state| run_export(app, state, &options, &worker_output),
    )
}

#[tauri::command]
fn list_whisper_models(app: AppHandle) -> Result<Vec<WhisperModelInfo>, String> {
    list_models(&app)
}

#[tauri::command]
fn start_model_download(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: ModelDownloadOptions,
) -> Result<String, String> {
    let model = validated_model(&options.model)?;
    let output_path = model_cache_dir(&probe_processor_paths(&app)?.hf_home, &model);
    start_background_job(
        app,
        &state,
        "Checking the private runtime",
        "Whisper model is ready",
        output_path,
        move |app, state| run_model_download(app, state, &model),
    )
}

#[tauri::command]
fn delete_whisper_model(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: ModelDownloadOptions,
) -> Result<(), String> {
    if state.running.load(Ordering::SeqCst) {
        return Err("Wait for the running process to finish first.".into());
    }
    delete_model(&app, &options.model)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServeMediaOptions {
    path: String,
}

#[tauri::command]
fn serve_media(options: ServeMediaOptions) -> Result<String, String> {
    media_server::serve_media(std::path::Path::new(options.path.trim()))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenDirectoryOptions {
    path: String,
}

#[tauri::command]
fn open_directory(options: OpenDirectoryOptions) -> Result<(), String> {
    let raw_path = options.path.trim();
    if raw_path.is_empty() {
        return Err("Choose an output folder first.".into());
    }

    let directory = PathBuf::from(raw_path);
    let metadata = fs::metadata(&directory)
        .map_err(|error| format!("Could not open {}: {error}", directory.display()))?;
    if !metadata.is_dir() {
        return Err(format!("{} is not a folder.", directory.display()));
    }

    open_directory_in_file_manager(&directory)
}

fn open_directory_in_file_manager(directory: &Path) -> Result<(), String> {
    let result = {
        #[cfg(target_os = "macos")]
        {
            Command::new("open").arg(directory).status()
        }
        #[cfg(target_os = "windows")]
        {
            Command::new("explorer").arg(directory).status()
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            Command::new("xdg-open").arg(directory).status()
        }
    };

    let status =
        result.map_err(|error| format!("Could not open {}: {error}", directory.display()))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Could not open {}.", directory.display()))
    }
}

#[tauri::command]
fn list_subtitle_files(options: SubtitleListOptions) -> Vec<SubtitleFile> {
    player::list_subtitle_files(std::path::Path::new(options.video_path.trim()))
}

#[tauri::command]
fn read_subtitle_file(options: SubtitleReadOptions) -> Result<String, String> {
    player::read_subtitle_file(std::path::Path::new(options.path.trim()))
}

#[tauri::command]
fn load_cue_ignores(options: IgnoreLoadOptions) -> Result<Vec<String>, String> {
    player::load_cue_ignores(std::path::Path::new(options.subtitle_path.trim()))
}

#[tauri::command]
fn save_cue_ignores(options: IgnoreSaveOptions) -> Result<(), String> {
    player::save_cue_ignores(
        std::path::Path::new(options.subtitle_path.trim()),
        &options.keys,
    )
}

#[tauri::command]
fn get_default_grab_output_dir() -> Result<String, String> {
    let output_dir = default_grab_output_dir();
    fs::create_dir_all(&output_dir)
        .map_err(|error| format!("Could not create {}: {error}", output_dir.display()))?;
    Ok(output_dir.display().to_string())
}

#[tauri::command]
fn list_material_videos(
    app: AppHandle,
    state: State<'_, ConversionState>,
    options: MaterialGalleryOptions,
) -> Result<Vec<MaterialVideo>, String> {
    let directory = if options.directory.trim().is_empty() {
        default_grab_output_dir()
    } else {
        PathBuf::from(options.directory.trim())
    };
    list_material_videos_inner(&app, &state, &directory)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrabTextListOptions {
    directory: String,
    url: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrabTextReadOptions {
    path: String,
}

#[tauri::command]
fn list_grab_text_files(options: GrabTextListOptions) -> Result<Vec<GrabTextFile>, String> {
    let directory = if options.directory.trim().is_empty() {
        default_grab_output_dir()
    } else {
        PathBuf::from(options.directory.trim())
    };
    list_grab_text_files_inner(&directory, options.url.as_deref())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChapterRenderOptions {
    chapters: Vec<GrabChapter>,
    format: String,
}

/// Renders chapters for the clipboard through the same function that writes
/// the files, so what you copy matches what you would have downloaded.
#[tauri::command]
fn render_grab_chapters(options: ChapterRenderOptions) -> Result<String, String> {
    if options.chapters.is_empty() {
        return Err("This video has no chapters to copy.".into());
    }
    Ok(render_chapters(&options.chapters, &options.format))
}

#[tauri::command]
fn read_grab_text_file(options: GrabTextReadOptions) -> Result<String, String> {
    read_grab_text_file_inner(std::path::Path::new(options.path.trim()))
}

#[tauri::command]
fn delete_grab_text_file(options: GrabTextReadOptions) -> Result<(), String> {
    delete_grab_text_file_inner(std::path::Path::new(options.path.trim()))
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
    let url = options.url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Enter a valid http or https URL first.".into());
    }
    if !options.video && !options.audio && !options.subs && !options.chapters {
        return Err("Turn on at least one track.".into());
    }
    if options.audio && options.audio_langs.is_empty() {
        return Err("Choose at least one audio language.".into());
    }
    if options.subs {
        if options.manual_langs.is_empty() && options.auto_langs.is_empty() {
            return Err("Choose at least one subtitle track.".into());
        }
        if options.subtitle_formats.is_empty() {
            return Err("Choose at least one subtitle format.".into());
        }
        if options
            .subtitle_formats
            .iter()
            .any(|format| !matches!(format.as_str(), "srt" | "vtt" | "json3"))
        {
            return Err("Subtitle formats must be SRT, WebVTT, or JSON3.".into());
        }
    }
    if options.chapters {
        if options.chapter_formats.is_empty() {
            return Err("Choose at least one chapter format.".into());
        }
        if options
            .chapter_formats
            .iter()
            .any(|format| !matches!(format.as_str(), "json" | "txt"))
        {
            return Err("Chapter formats must be JSON or plain text.".into());
        }
    }
    let output_dir = if options.output_dir.trim().is_empty() {
        default_grab_output_dir()
    } else {
        PathBuf::from(options.output_dir.trim())
    };

    let worker_output = output_dir.clone();
    start_background_job(
        app,
        &state,
        "Checking downloader tools",
        "Material is ready",
        output_dir,
        move |app, state| run_grab(app, state, &options, &worker_output),
    )
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            get_runtime_status,
            get_downloader_status,
            get_default_grab_output_dir,
            open_directory,
            list_material_videos,
            list_grab_text_files,
            read_grab_text_file,
            delete_grab_text_file,
            render_grab_chapters,
            start_conversion,
            start_slowdown,
            start_convert,
            start_audio_video,
            start_merge,
            start_transcribe,
            list_whisper_models,
            start_model_download,
            delete_whisper_model,
            start_downloader_install,
            serve_media,
            list_subtitle_files,
            read_subtitle_file,
            load_cue_ignores,
            save_cue_ignores,
            start_dialogue_export,
            probe_grab,
            start_grab,
            stop_conversion
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
