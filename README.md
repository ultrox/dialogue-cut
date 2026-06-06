# Dialogue Cut

Dialogue Cut creates reviewable dialogue-only cuts from local video files. It can
use embedded subtitles when they are useful, or generate German timestamps with
MLX Whisper, then render a QuickTime-safe H.264/AAC MP4.

It also includes a video-processing tab for slowing audio and video together,
which is useful when preparing footage for dubbing practice.

The desktop app also has a material-grabber tab that wraps `yt-dlp` for this
workflow: paste one URL, click `Start`, then choose video quality and exact
subtitle tracks before the same button changes to `Download`.

Use it only with media you have the right to process.

## Desktop App

```bash
cd ui
npm install
npm run tauri dev
```

## CLI

```bash
python3 dialogue-only.py /path/to/movie.mkv
```

Force a fresh German Whisper transcript:

```bash
python3 dialogue-only.py /path/to/movie.mkv --force-transcribe
```

Tune the cut feel:

```bash
python3 dialogue-only.py /path/to/movie.mkv --pre-pad 0.3 --post-pad 0.5 --merge-gap 1.0
```

## Slow-Down Transcode

In the desktop app, open `Video processing`, choose a video, set the playback
speed, and start the transcode. A `0.50x` output is twice as long as the input.
Audio is slowed with ffmpeg `atempo`, so pitch is preserved.

The output is written beside the source video:

```txt
movie.slow-0.50x.mp4
```

## Material Grabber

In the desktop app, open `Material grabber`, paste a URL, and click `Start`.
The app asks `yt-dlp` for metadata first, then shows available video heights and
exact subtitle language tracks. The output folder defaults to
`~/Downloads/Dialogue Cut Material`; change it from `Output settings` only
when you want a different destination. The same button changes to `Download`
after metadata is loaded. The app uses a fixed `yt-dlp` preset:

- one URL at a time, no playlist expansion
- selected quality cap, best available, or `No video`
- MP4 remux when possible
- optional selected manual or generated subtitles converted to SRT
- exact subtitle language keys from metadata, not wildcard language matching

## Distribution

Build an Apple Silicon macOS app and DMG:

```bash
cd ui
npm run bundle:mac
```

The packaged app installs a checksum-verified private Python runtime, static
`ffmpeg`/`ffprobe`, MLX Whisper dependencies, and `yt-dlp` when needed.
Whisper model files download automatically on first transcription and stay
cached in the app's Application Support directory.

Current packaged target: Apple Silicon Mac with macOS 13.5 or newer.

## Solo

The repo includes a Solo command:

```txt
Dialogue Cut UI
```

It runs `npm run tauri dev` from `ui`.

## Details

See [DIALOGUE_ONLY.md](DIALOGUE_ONLY.md) for the full workflow, project JSON
format, and manual adjustment notes.
