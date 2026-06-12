//! The ffmpeg/ffprobe domain: media inspection, the fluent ffmpeg builder,
//! and small media helpers (thumbnails, filter strings).

use std::{
    path::{Path, PathBuf},
    process::Command,
};
use tauri::AppHandle;

use crate::process::{run_ffmpeg_with_progress_window, ConversionState};
use crate::runtime::{prepend_media_path, ProcessorPaths};

/// Read-only media inspection via the bundled ffprobe.
pub(crate) struct MediaProbe {
    binary: PathBuf,
}

impl MediaProbe {
    pub(crate) fn new(paths: &ProcessorPaths) -> Self {
        Self {
            binary: paths.tools_dir.join("ffprobe"),
        }
    }

    fn entry(&self, target: &Path, args: &[&str]) -> Option<String> {
        let output = Command::new(&self.binary)
            .args(["-v", "error"])
            .args(args)
            .args(["-of", "default=nokey=1:noprint_wrappers=1"])
            .arg(target)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }

    pub(crate) fn duration(&self, target: &Path) -> Option<f64> {
        self.entry(target, &["-show_entries", "format=duration"])?
            .parse()
            .ok()
    }

    pub(crate) fn video_codec(&self, target: &Path) -> Option<String> {
        self.entry(
            target,
            &["-select_streams", "v:0", "-show_entries", "stream=codec_name"],
        )
    }

    pub(crate) fn video_dimensions(&self, target: &Path) -> Option<(u32, u32)> {
        let output = self.entry(
            target,
            &["-select_streams", "v:0", "-show_entries", "stream=width,height"],
        )?;
        let mut lines = output.lines();
        let width = lines.next()?.parse().ok()?;
        let height = lines.next()?.parse().ok()?;
        Some((width, height))
    }

    pub(crate) fn has_audio(&self, target: &Path) -> bool {
        self.entry(
            target,
            &["-select_streams", "a:0", "-show_entries", "stream=index"],
        )
        .is_some()
    }
}

/// Fluent wrapper around the bundled ffmpeg. Centralizes the shared plumbing
/// (binary lookup, base flags, stream selection, QuickTime-safe encoder
/// recipes, progress reporting) so each workflow states only its intent.
pub(crate) struct Ffmpeg<'a> {
    paths: &'a ProcessorPaths,
    command: Command,
}

impl<'a> Ffmpeg<'a> {
    pub(crate) fn new(paths: &'a ProcessorPaths) -> Result<Self, String> {
        let binary = paths.tools_dir.join("ffmpeg");
        if !binary.is_file() {
            return Err(format!("ffmpeg not found at {}.", binary.display()));
        }
        let mut command = Command::new(binary);
        // errors-only: the metadata dump ffmpeg prints per run floods the UI
        // log when a job runs hundreds of commands (dialogue-cut segments).
        command
            .arg("-hide_banner")
            .args(["-loglevel", "error"])
            .arg("-y")
            .args(["-nostats", "-progress", "pipe:1"]);
        Ok(Self { paths, command })
    }

    /// Fast input seek; place before input(). Frame-accurate when combined
    /// with re-encoding.
    pub(crate) fn seek(mut self, seconds: f64) -> Self {
        self.command.args(["-ss", &format!("{seconds:.3}")]);
        self
    }

    pub(crate) fn input(mut self, path: &Path) -> Self {
        self.command.arg("-i").arg(path);
        self
    }

    /// Limits the output to this many seconds; place after input().
    pub(crate) fn clip_duration(mut self, seconds: f64) -> Self {
        self.command.args(["-t", &format!("{seconds:.3}")]);
        self
    }

    /// Reads a concat-demuxer list file as the input.
    pub(crate) fn concat_input(mut self, list_path: &Path) -> Self {
        self.command
            .args(["-f", "concat", "-safe", "0"])
            .arg("-i")
            .arg(list_path);
        self
    }

    pub(crate) fn copy_streams(mut self) -> Self {
        self.command.args(["-c", "copy"]);
        self
    }

    /// First video and audio stream only; drops subtitles, data streams, and
    /// chapters (chapters would otherwise become a bin_data track in MP4).
    pub(crate) fn main_movie_streams(mut self) -> Self {
        self.command
            .args(["-map", "0:v:0"])
            .args(["-map", "0:a:0?"])
            .arg("-sn")
            .arg("-dn")
            .args(["-map_chapters", "-1"]);
        self
    }

    pub(crate) fn first_audio_only(mut self) -> Self {
        self.command.args(["-map", "0:a:0"]).arg("-vn");
        self
    }

    pub(crate) fn video_filter(mut self, filter: &str) -> Self {
        self.command.args(["-vf", filter]);
        self
    }

    pub(crate) fn audio_filter(mut self, filter: &str) -> Self {
        self.command.args(["-af", filter]);
        self
    }

    pub(crate) fn copy_video(mut self, tag_hvc1: bool) -> Self {
        self.command.args(["-c:v", "copy"]);
        // QuickTime only plays HEVC-in-MP4 when it is tagged hvc1.
        if tag_hvc1 {
            self.command.args(["-tag:v", "hvc1"]);
        }
        self
    }

    /// QuickTime-safe H.264 encode.
    pub(crate) fn encode_h264(mut self, crf: u32) -> Self {
        self.command
            .args(["-c:v", "libx264"])
            .args(["-preset", "veryfast"])
            .args(["-crf", &crf.to_string()])
            .args(["-pix_fmt", "yuv420p"])
            .args(["-profile:v", "high"]);
        self
    }

    pub(crate) fn aac_audio(mut self) -> Self {
        self.command.args(["-c:a", "aac"]).args(["-b:a", "192k"]);
        self
    }

    pub(crate) fn mp4_faststart(mut self) -> Self {
        self.command.args(["-movflags", "+faststart"]);
        self
    }

    /// Mono 16 kHz, the input format Whisper expects.
    pub(crate) fn whisper_wav(mut self) -> Self {
        self.command.args(["-ac", "1"]).args(["-ar", "16000"]);
        self
    }

    pub(crate) fn output(mut self, path: &Path) -> Self {
        self.command.arg(path);
        self
    }

    /// Runs the command, emitting conversion-progress events.
    /// `expected_duration` is the expected output duration used for the
    /// percentage; pass None when unknown.
    pub(crate) fn run(
        self,
        app: &AppHandle,
        state: &ConversionState,
        expected_duration: Option<f64>,
    ) -> Result<(), String> {
        self.run_window(app, state, 0.0, expected_duration)
    }

    /// Like run(), but for one command of a multi-command job: `offset` output
    /// seconds are already done and progress is reported against `total`.
    pub(crate) fn run_window(
        mut self,
        app: &AppHandle,
        state: &ConversionState,
        offset: f64,
        total: Option<f64>,
    ) -> Result<(), String> {
        prepend_media_path(&mut self.command, self.paths);
        run_ffmpeg_with_progress_window(app, state, &mut self.command, offset, total)
    }
}

/// ffmpeg `atempo` only accepts 0.5–2.0 per stage; chain stages for slower
/// or faster rates.
pub(crate) fn atempo_filter(speed: f64) -> String {
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

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = *chunk.get(1).unwrap_or(&0);
        let third = *chunk.get(2).unwrap_or(&0);
        let combined = ((first as u32) << 16) | ((second as u32) << 8) | third as u32;

        encoded.push(TABLE[((combined >> 18) & 0x3f) as usize] as char);
        encoded.push(TABLE[((combined >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            encoded.push(TABLE[((combined >> 6) & 0x3f) as usize] as char);
        } else {
            encoded.push('=');
        }
        if chunk.len() > 2 {
            encoded.push(TABLE[(combined & 0x3f) as usize] as char);
        } else {
            encoded.push('=');
        }
    }
    encoded
}

pub(crate) fn thumbnail_data_url(
    paths: &ProcessorPaths,
    video_path: &Path,
    duration: Option<f64>,
) -> Option<String> {
    let seek = duration
        .filter(|duration| *duration > 8.0)
        .map(|duration| (duration * 0.08).clamp(1.0, 30.0))
        .unwrap_or(1.0);
    let seek = format!("{seek:.3}");
    let output = Command::new(paths.tools_dir.join("ffmpeg"))
        .args(["-hide_banner", "-loglevel", "error", "-ss", &seek, "-i"])
        .arg(video_path)
        .args([
            "-frames:v",
            "1",
            "-vf",
            "scale=320:-1",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "-q:v",
            "5",
            "pipe:1",
        ])
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.is_empty() {
        return None;
    }
    Some(format!(
        "data:image/jpeg;base64,{}",
        base64_encode(&output.stdout)
    ))
}
