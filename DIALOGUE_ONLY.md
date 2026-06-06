# Dialogue-Only Cuts

## Folder Layout

From the `movies` folder:

```txt
dialogue-tool/                    reusable scripts and MLX Whisper venv
Ein.Koenigreich.fuer.ein.Lama.2000/  one movie project with source, transcript, outputs
```

## Desktop UI

The Tauri desktop app lives in `dialogue-tool/ui`.

```bash
cd dialogue-tool/ui
npm run tauri dev
```

## Solo

The repo has a `solo.yml` command:

```txt
Dialogue Cut UI
```

It runs:

```bash
npm run tauri dev
```

from `ui`. Because this is a YAML-backed command, Solo may ask you
to trust it once before it can be started from the UI.

The browser-only layout preview is:

```bash
npm run dev -- --host 127.0.0.1
```

Use the desktop window to select a video, tune padding, force Whisper when
embedded subtitles are incomplete, start a conversion, cancel a run, and watch
the live process log.

The `Video processing` tab creates slowed H.264/AAC MP4 files for dubbing
practice. For example, `0.50x` doubles the duration while preserving audio pitch.
Outputs are written beside the source video as `movie.slow-0.50x.mp4`.

The `Material grabber` tab wraps `yt-dlp` for one-URL downloads. Paste a URL,
choose a folder, and choose whether to download video, subtitles, or both. The
default subtitle language field is `de,en`, which asks `yt-dlp` for German and
English caption tracks when available. Subtitle files are converted to SRT.

### Shareable macOS app

Build the Apple Silicon macOS app and DMG:

```bash
cd dialogue-tool/ui
npm run bundle:mac
```

The output is written under:

```txt
src-tauri/target/release/bundle/macos/Dialogue Cut.app
src-tauri/target/release/bundle/dmg/Dialogue Cut_0.1.0_aarch64.dmg
```

The shared app does not rely on Homebrew or a system Python installation. On
the first conversion it installs a checksum-verified private Python runtime,
`ffmpeg`, `ffprobe`, MLX Whisper dependencies, and `yt-dlp` under the app's
Application Support directory. The Whisper model downloads automatically on the
first transcription and remains cached.

Current distribution target: Apple Silicon Mac with macOS 13.5 or newer.

The local DMG uses an ad-hoc signature. On another Mac, allow it once in
**System Settings > Privacy & Security** after macOS blocks the first launch.
Normal double-click installation without that Gatekeeper step requires Apple
Developer ID signing and notarization.

## One command

```bash
python3 dialogue-tool/dialogue-only.py "MovieFolder/movie.mkv"
```

Default behavior:

- picks the German audio stream tagged `ger`
- uses embedded German subtitles if the file has them
- otherwise extracts German audio and transcribes it with MLX Whisper
- creates `movie.dialogue-only.mp4`
- caches the extracted `.16k.wav` and `.srt` beside the movie
- creates `movie.dialogue-project.json` for manual adjustments
- creates `movie.dialogue-review.txt` with suspicious Whisper cues to inspect
- builds ranges from dialogue cues, while still preserving nearby action through padding/merge
- keeps `dialogue` and `mixed` segments, drops pure noise/vocal/song/suspect cue ranges
- renders synced, QuickTime-safe H.264/AAC chunks and stitches them together

## Reuse an existing transcript

```bash
python3 dialogue-tool/dialogue-only.py "MovieFolder/movie.mkv" --subtitles "MovieFolder/movie.de.srt"
```

## Different language

For an English track:

```bash
python3 dialogue-tool/dialogue-only.py "MovieFolder/movie.mkv" --language eng --whisper-language en
```

## Tune cut feel

```bash
python3 dialogue-tool/dialogue-only.py "MovieFolder/movie.mkv" --pre-pad 0.4 --post-pad 0.8 --merge-gap 1.2
```

Recommended defaults are `0.3s` before dialogue, `0.5s` after dialogue, and merge gaps up to `1.0s`.
Dropped non-dialogue cues must overlap a kept segment by at least `0.75s` before
the segment is labeled `mixed`; tiny overlaps from padding are ignored.

## Tune what gets kept

Default:

```bash
python3 dialogue-tool/dialogue-only.py "MovieFolder/movie.mkv" --keep-cue-classes dialogue --keep-sources dialogue,mixed
```

Use `--keep-cue-classes all --keep-sources all` if you want to keep every transcript-driven range.

## Manual-adjustable project

The project keeps dropped transcript cues as metadata. It labels suspicious cues
like long hallucinated lines, screams, noises, or likely songs so you can review
what was removed without losing the audit trail.

Create editable JSON and a review report from a transcript:

```bash
python3 dialogue-tool/dialogue_project.py create "MovieFolder/movie.mkv" "MovieFolder/movie.de.srt" "MovieFolder/movie.dialogue-project.json" --keep-cue-classes dialogue --keep-sources dialogue,mixed --review-report "MovieFolder/movie.dialogue-review.txt"
```

Print the review list:

```bash
python3 dialogue-tool/dialogue_project.py review "MovieFolder/movie.dialogue-project.json"
```

Render that JSON:

```bash
python3 dialogue-tool/dialogue_project.py render "MovieFolder/movie.dialogue-project.json" "MovieFolder/movie.dialogue-only.mp4"
```

To keep a silent reaction or visual gag, add a segment in the JSON:

```json
{
  "id": "manual-0001",
  "start": 123.4,
  "end": 126.8,
  "enabled": true,
  "source": "manual",
  "text": "visual gag"
}
```

To remove a bad transcript-driven segment later, set `"enabled": false` on that
segment. To keep the scene but document why, leave it enabled and edit `"source"`
or `"text"` to describe the visual beat.
