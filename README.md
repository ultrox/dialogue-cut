# Dialogue Cut

Dialogue Cut creates reviewable dialogue-only cuts from local video files. It can
use embedded subtitles when they are useful, or generate German timestamps with
MLX Whisper, then render a QuickTime-safe H.264/AAC MP4.

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

## Distribution

Build an Apple Silicon macOS app and DMG:

```bash
cd ui
npm run bundle:mac
```

The packaged app installs a checksum-verified private Python runtime, static
`ffmpeg`/`ffprobe`, and MLX Whisper dependencies on first use. Whisper model
files download automatically on first transcription and stay cached in the
app's Application Support directory.

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

