# Third-Party Notices

Dialogue Cut installs a private processing runtime on first use. The downloaded
files are checksum-verified before use.

## Python

The relocatable CPython runtime is downloaded from the
[Astral python-build-standalone releases](https://github.com/astral-sh/python-build-standalone/releases).
Python is distributed under the Python Software Foundation License.

## FFmpeg

The static `ffmpeg` and `ffprobe` executables are downloaded from the
[`eugeneware/ffmpeg-static` releases](https://github.com/eugeneware/ffmpeg-static/releases).
Those macOS builds are distributed under the GPL. FFmpeg source and licensing
information are available from [ffmpeg.org](https://ffmpeg.org/).

## MLX Whisper

The private Python runtime installs
[`mlx-whisper`](https://github.com/ml-explore/mlx-examples/tree/main/whisper)
and its Python dependencies from PyPI. Whisper model files are downloaded from
the selected Hugging Face model repository on first transcription and cached
under Dialogue Cut's Application Support directory.

## yt-dlp

The material grabber installs [`yt-dlp`](https://github.com/yt-dlp/yt-dlp), its
[`yt-dlp-ejs`](https://github.com/yt-dlp/ejs) challenge scripts, the
[`deno`](https://github.com/denoland/deno) JavaScript runtime, and the
[`bgutil-ytdlp-pot-provider`](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
PO-token provider with its dependencies into the private runtime when needed.
They are not included in the app bundle and can be updated independently from
the Material Grabber interface. The provider uses the private Deno runtime to
perform YouTube's proof-of-origin verification without launching a browser.
