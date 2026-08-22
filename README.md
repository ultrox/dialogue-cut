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

The tab also shows a thumbnail gallery of videos from the Material grabber
Output settings folder. Click a thumbnail to select that video for slow-down.

The output is written beside the source video:

```txt
movie.slow-0.50x.mp4
```

## Converter

In the desktop app, open `Converter`, choose a video (typically an MKV), and
start the conversion. The MP4 is written beside the source with the same name
(or `movie.converted.mp4` if that name is taken). Two modes:

- `Re-encode H.264/AAC` (default): most compatible for editing; re-encodes
  everything, so it takes a while.
- `Fast remux`: copies the video stream as-is into MP4 and converts audio to
  AAC. Nearly instant, but editors may struggle with HEVC/AV1 sources.

Embedded subtitles and chapters are dropped; only the first video and audio
streams are kept.

## Transcription

In the desktop app, open `Transcription`, choose a video or audio file, pick
the spoken language (German by default, or auto-detect), and tick the output
files you want. The app extracts the first audio track, transcribes it with
MLX Whisper, and writes the selected files beside the source:

- `movie.de.srt` / `movie.de.vtt` — subtitles (on by default)
- `movie.de.txt` — plain text transcript (on by default)
- `movie.de.json` — raw Whisper output with segments and timestamps
- `movie.de.tsv` — start/end/text timestamp table

With auto-detect the language suffix is omitted.

## Material Grabber

In the desktop app, open `Material grabber`, paste a URL, and click `Start`.
The app asks `yt-dlp` for metadata first, then shows available video heights and
exact subtitle language tracks. The output folder defaults to
`~/Downloads/Dialogue Cut Material`; change it from `Output settings` only
when you want a different destination. Each URL is saved into its own
`Title [id]` subfolder. The same button changes to `Download` after metadata
is loaded. `yt-dlp` is not bundled with the app: the managed copy downloads on
the first scan. The Grabber checks it against the latest PyPI release and shows
an `Update` button when an older version must be replaced. For YouTube, the
managed bgutil provider performs playback verification through the private Deno
runtime without opening a browser. The app uses a fixed `yt-dlp` preset:

- one URL at a time, no playlist expansion
- selected quality cap, best available, or `No video`
- MP4 remux when possible
- optional selected manual or generated subtitles converted to SRT
- optional raw automatic captions as JSON3 for the selected subtitle languages
- exact subtitle language keys from metadata, not wildcard language matching

## Distribution

Build an Apple Silicon macOS app and DMG:

```bash
cd ui
npm run bundle:mac
```

The packaged app does not bundle its large and frequently updated runtime
dependencies. It installs a checksum-verified private Python runtime, static
`ffmpeg`/`ffprobe`, MLX Whisper dependencies, and `yt-dlp` only when needed.
Whisper model files download automatically on first transcription and stay
cached in the app's Application Support directory. The managed `yt-dlp` copy
can be updated independently from the app in Material Grabber.

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
