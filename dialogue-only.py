#!/usr/bin/env python3
import argparse
import json
import shlex
import subprocess
import sys
from pathlib import Path


DEFAULT_MODEL = "mlx-community/whisper-small-mlx"


def run(command, dry_run=False):
    print(" ".join(shlex.quote(str(part)) for part in command))
    if dry_run:
        return None
    return subprocess.run(command, check=True)


def capture_json(command):
    result = subprocess.run(command, check=True, text=True, capture_output=True)
    return json.loads(result.stdout)


def find_streams(video_path):
    return capture_json(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=index,codec_type:stream_tags=language,title",
            "-of",
            "json",
            str(video_path),
        ]
    )["streams"]


def pick_audio_stream(streams, language):
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if not audio_streams:
        sys.exit("No audio streams found.")

    language = language.lower()
    for relative_index, stream in enumerate(audio_streams):
        tags = stream.get("tags") or {}
        if (tags.get("language") or "").lower() == language:
            return relative_index, stream

    print(
        f"No audio stream tagged {language!r}; using first audio stream "
        f"(file stream #{audio_streams[0]['index']})."
    )
    return 0, audio_streams[0]


def pick_subtitle_stream(streams, language):
    subtitle_streams = [
        stream for stream in streams if stream.get("codec_type") == "subtitle"
    ]
    language = language.lower()
    for relative_index, stream in enumerate(subtitle_streams):
        tags = stream.get("tags") or {}
        if (tags.get("language") or "").lower() == language:
            return relative_index, stream
    return None, None


def default_cache_prefix(video_path, language):
    return f"{video_path.stem}.{language}"


def sidecar_path(output_path, suffix):
    stem = output_path.stem
    if stem.endswith(".dialogue-only"):
        stem = stem[: -len(".dialogue-only")]
    return output_path.with_name(f"{stem}{suffix}")


def process_video(args, video):
    script_dir = Path(__file__).resolve().parent
    venv_dir = args.venv_dir or script_dir / ".dialogue-venv"
    if not venv_dir.is_absolute():
        venv_dir = (Path.cwd() / venv_dir).resolve()

    video_path = video.resolve()
    if not video_path.exists():
        sys.exit(f"Video not found: {video_path}")

    work_dir = args.work_dir or video_path.parent
    work_dir.mkdir(parents=True, exist_ok=True)
    output_path = args.output or video_path.with_name(f"{video_path.stem}.dialogue-only.mp4")
    project_path = args.project or sidecar_path(output_path, ".dialogue-project.json")
    review_report = args.review_report or sidecar_path(output_path, ".dialogue-review.txt")
    cache_prefix = args.cache_prefix or default_cache_prefix(video_path, args.language)
    audio_path = work_dir / f"{cache_prefix}.16k.wav"
    srt_path = args.subtitles or (work_dir / f"{cache_prefix}.srt")
    if args.subtitles:
        srt_path = srt_path.resolve()

    streams = find_streams(video_path)
    audio_relative_index, audio_stream = pick_audio_stream(streams, args.language)
    subtitle_relative_index, subtitle_stream = pick_subtitle_stream(
        streams, args.language
    )

    print(f"\n==> {video_path.name}")
    print(
        f"Audio: file stream #{audio_stream['index']} -> concat map 0:a:{audio_relative_index}"
    )

    use_embedded_subtitles = subtitle_stream and not args.force_transcribe

    if args.subtitles:
        print(f"Using provided subtitle/transcript file: {srt_path}")
    elif use_embedded_subtitles and (
        args.force_subtitle_extract or not srt_path.exists()
    ):
        print(f"Extracting subtitles from file stream #{subtitle_stream['index']}...")
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-y",
                "-i",
                str(video_path),
                "-map",
                f"0:s:{subtitle_relative_index}",
                str(srt_path),
            ],
            args.dry_run,
        )
    elif use_embedded_subtitles:
        print(f"Using cached subtitle file: {srt_path}")
    elif subtitle_stream and args.force_transcribe:
        tags = subtitle_stream.get("tags") or {}
        title = tags.get("title") or "untitled"
        print(
            f"Ignoring embedded subtitle stream #{subtitle_stream['index']} "
            f"({title}) because --force-transcribe was set."
        )

    should_transcribe = not args.subtitles and (
        args.force_transcribe or not srt_path.exists()
    )
    if should_transcribe:
        print(f"Extracting {args.language} audio for Whisper...")
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-y",
                "-i",
                str(video_path),
                "-map",
                f"0:a:{audio_relative_index}",
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                str(audio_path),
            ],
            args.dry_run,
        )

        mlx_whisper = venv_dir / "bin" / "mlx_whisper"
        if not mlx_whisper.exists():
            sys.exit(
                f"mlx_whisper not found at {mlx_whisper}. Install it with:\n"
                f"{venv_dir}/bin/python -m pip install mlx-whisper"
            )

        print("Transcribing with MLX Whisper...")
        run(
            [
                str(mlx_whisper),
                str(audio_path),
                "--model",
                args.model,
                "--language",
                args.whisper_language,
                "--output-format",
                "all",
                "--output-dir",
                str(work_dir),
                "--output-name",
                cache_prefix,
                "--condition-on-previous-text",
                "False",
            ],
            args.dry_run,
        )
    elif not args.subtitles and not use_embedded_subtitles:
        print(f"Using cached transcript file: {srt_path}")

    if not args.dry_run and not srt_path.exists():
        fallback_srt_path = work_dir / f"{video_path.stem}.srt"
        if fallback_srt_path.exists():
            print(
                f"Expected transcript {srt_path.name} was not found; "
                f"using {fallback_srt_path.name}."
            )
            srt_path = fallback_srt_path

    if not args.dry_run and not srt_path.exists():
        sys.exit(f"Subtitle/transcript file was not created: {srt_path}")

    if not args.no_project:
        print("Creating editable dialogue project and review report...")
        run(
            [
                sys.executable,
                str(script_dir / "dialogue_project.py"),
                "create",
                str(video_path),
                str(srt_path),
                str(project_path),
                "--language",
                args.language,
                "--pre-pad",
                str(args.pre_pad),
                "--post-pad",
                str(args.post_pad),
                "--merge-gap",
                str(args.merge_gap),
                "--incidental-min-overlap",
                str(args.incidental_min_overlap),
                "--keep-cue-classes",
                args.keep_cue_classes,
                "--keep-sources",
                args.keep_sources,
                "--review-report",
                str(review_report),
            ],
            args.dry_run,
        )

    print("Creating dialogue-only video...")
    if args.no_project:
        run(
            [
                sys.executable,
                str(script_dir / "make-dialogue-cut.py"),
                str(video_path),
                str(srt_path),
                str(output_path),
                "--pre-pad",
                str(args.pre_pad),
                "--post-pad",
                str(args.post_pad),
                "--merge-gap",
                str(args.merge_gap),
                "--mode",
                args.mode,
                "--audio-map",
                f"0:a:{audio_relative_index}",
            ],
            args.dry_run,
        )
    else:
        run(
            [
                sys.executable,
                str(script_dir / "dialogue_project.py"),
                "render",
                str(project_path),
                str(output_path),
                "--audio-map",
                f"0:a:{audio_relative_index}",
            ],
            args.dry_run,
        )


def main():
    parser = argparse.ArgumentParser(
        description="Create a dialogue-only video from embedded subtitles or Whisper timestamps."
    )
    parser.add_argument("video", type=Path, nargs="+")
    parser.add_argument("-l", "--language", default="ger")
    parser.add_argument("--whisper-language", default="de")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--project", type=Path)
    parser.add_argument("--review-report", type=Path)
    parser.add_argument("--work-dir", type=Path)
    parser.add_argument("--venv-dir", type=Path)
    parser.add_argument("--subtitles", type=Path)
    parser.add_argument("--cache-prefix")
    parser.add_argument("--pre-pad", type=float, default=0.3)
    parser.add_argument("--post-pad", type=float, default=0.5)
    parser.add_argument("--merge-gap", type=float, default=1.0)
    parser.add_argument("--incidental-min-overlap", type=float, default=0.75)
    parser.add_argument("--keep-cue-classes", default="dialogue")
    parser.add_argument("--keep-sources", default="dialogue,mixed")
    parser.add_argument("--force-transcribe", action="store_true")
    parser.add_argument("--force-subtitle-extract", action="store_true")
    parser.add_argument("--mode", choices=["copy", "encode"], default="encode")
    parser.add_argument("--no-project", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if len(args.video) > 1 and (
        args.output
        or args.project
        or args.review_report
        or args.subtitles
        or args.cache_prefix
    ):
        sys.exit(
            "--output, --project, --review-report, --subtitles, and --cache-prefix "
            "can only be used with one video."
        )

    for video in args.video:
        process_video(args, video)


if __name__ == "__main__":
    main()
