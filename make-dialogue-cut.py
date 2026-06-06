#!/usr/bin/env python3
import argparse
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path


SRT_TIME_RE = re.compile(
    r"(?P<start>\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*"
    r"(?P<end>\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})"
)


def parse_timestamp(value):
    value = value.strip().replace(",", ".")
    hours, minutes, seconds = value.split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def parse_ass_timestamp(value):
    hours, minutes, seconds = value.strip().split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def read_srt(path):
    ranges = []
    for match in SRT_TIME_RE.finditer(path.read_text(encoding="utf-8-sig", errors="replace")):
        start = parse_timestamp(match.group("start"))
        end = parse_timestamp(match.group("end"))
        if end > start:
            ranges.append((start, end))
    return ranges


def split_ass_dialogue(line, field_count):
    payload = line.split(":", 1)[1].lstrip()
    return payload.split(",", field_count - 1)


def read_ass(path):
    ranges = []
    in_events = False
    fields = []
    for raw_line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        line = raw_line.strip()
        if not line:
            continue
        lower = line.lower()
        if lower == "[events]":
            in_events = True
            continue
        if in_events and line.startswith("["):
            in_events = False
            continue
        if not in_events:
            continue
        if lower.startswith("format:"):
            fields = [part.strip().lower() for part in line.split(":", 1)[1].split(",")]
            continue
        if lower.startswith("dialogue:") and fields:
            parts = split_ass_dialogue(line, len(fields))
            try:
                start = parse_ass_timestamp(parts[fields.index("start")])
                end = parse_ass_timestamp(parts[fields.index("end")])
            except (ValueError, IndexError):
                continue
            if end > start:
                ranges.append((start, end))
    return ranges


def read_subtitle_ranges(path):
    suffix = path.suffix.lower()
    if suffix == ".srt":
        return read_srt(path)
    if suffix in {".ass", ".ssa"}:
        return read_ass(path)
    raise ValueError(f"Unsupported subtitle format: {path.suffix}")


def merge_ranges(ranges, pre_pad, post_pad, merge_gap):
    padded = sorted((max(0.0, start - pre_pad), end + post_pad) for start, end in ranges)
    merged = []
    for start, end in padded:
        if not merged or start - merged[-1][1] > merge_gap:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    return [(start, end) for start, end in merged if end > start]


def ffconcat_quote(path):
    return "'" + str(path).replace("'", "'\\''") + "'"


def write_concat_file(video_path, ranges, concat_path):
    video_path = video_path.resolve()
    with concat_path.open("w", encoding="utf-8") as handle:
        handle.write("ffconcat version 1.0\n")
        for start, end in ranges:
            handle.write(f"file {ffconcat_quote(video_path)}\n")
            handle.write(f"inpoint {start:.3f}\n")
            handle.write(f"outpoint {end:.3f}\n")


def write_select_filter(ranges, filter_path, video_map, audio_map):
    expression = "+".join(
        f"between(t,{start:.3f},{end:.3f})" for start, end in ranges
    )
    with filter_path.open("w", encoding="utf-8") as handle:
        handle.write(
            f"[{video_map}]select='{expression}',"
            "setpts=N/FRAME_RATE/TB,format=yuv420p[vout];\n"
        )
        handle.write(
            f"[{audio_map}]aselect='{expression}',"
            "asetpts=N/SR/TB[aout]\n"
        )


def format_duration(seconds):
    seconds = int(round(seconds))
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def build_ffmpeg_command(concat_path, output_path, mode, video_map, audio_map):
    base = [
        "ffmpeg",
        "-hide_banner",
        "-y",
        "-safe",
        "0",
        "-f",
        "concat",
        "-segment_time_metadata",
        "1",
        "-i",
        str(concat_path),
        "-map",
        video_map,
        "-map",
        audio_map,
        "-sn",
    ]
    if mode == "copy":
        return base + ["-c", "copy", "-avoid_negative_ts", "make_zero", str(output_path)]
    return base + [
        "-vf",
        "select=concatdec_select,setpts=N/FRAME_RATE/TB",
        "-af",
        "aselect=concatdec_select,asetpts=N/SR/TB",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        str(output_path),
    ]


def build_select_ffmpeg_command(video_path, filter_path, output_path):
    return [
        "ffmpeg",
        "-hide_banner",
        "-y",
        "-i",
        str(video_path),
        "-filter_complex_script",
        str(filter_path),
        "-map",
        "[vout]",
        "-map",
        "[aout]",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(output_path),
    ]


def build_segment_ffmpeg_command(video_path, output_path, start, end, video_map, audio_map):
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        f"{start:.3f}",
        "-i",
        str(video_path),
        "-t",
        f"{end - start:.3f}",
        "-map",
        video_map,
        "-map",
        audio_map,
        "-sn",
        "-vf",
        "setpts=PTS-STARTPTS,format=yuv420p",
        "-af",
        "asetpts=PTS-STARTPTS",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-movflags",
        "+faststart",
        str(output_path),
    ]


def build_concat_parts_command(concat_path, output_path):
    return [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-safe",
        "0",
        "-f",
        "concat",
        "-i",
        str(concat_path),
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        str(output_path),
    ]


def render_segment_files(video_path, ranges, output_path, parts_dir, video_map, audio_map, dry_run):
    parts_dir.mkdir(parents=True, exist_ok=True)
    part_paths = []
    for index, (start, end) in enumerate(ranges, start=1):
        part_path = parts_dir / f"part-{index:04d}.mp4"
        part_paths.append(part_path)
        print(
            f"Rendering segment {index}/{len(ranges)}: {start:.3f} -> {end:.3f}",
            flush=True,
        )
        command = build_segment_ffmpeg_command(
            video_path, part_path, start, end, video_map, audio_map
        )
        if dry_run:
            print(" ".join(shlex.quote(part) for part in command))
        else:
            subprocess.run(command, check=True)

    concat_path = output_path.with_suffix(".parts.ffconcat")
    with concat_path.open("w", encoding="utf-8") as handle:
        handle.write("ffconcat version 1.0\n")
        for part_path in part_paths:
            handle.write(f"file {ffconcat_quote(part_path.resolve())}\n")

    print(f"Parts dir:       {parts_dir}")
    print(f"Parts concat:    {concat_path}")
    command = build_concat_parts_command(concat_path, output_path)
    print("ffmpeg command:")
    print(" ".join(shlex.quote(part) for part in command))
    if not dry_run:
        subprocess.run(command, check=True)


def main():
    parser = argparse.ArgumentParser(
        description="Create a dialogue-only cut from subtitle or transcript timestamps."
    )
    parser.add_argument("video", type=Path)
    parser.add_argument("subtitles", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--pre-pad", type=float, default=0.3)
    parser.add_argument("--post-pad", type=float, default=0.5)
    parser.add_argument("--merge-gap", type=float, default=1.0)
    parser.add_argument("--concat-file", type=Path)
    parser.add_argument("--filter-file", type=Path)
    parser.add_argument("--parts-dir", type=Path)
    parser.add_argument(
        "--method", choices=["segments", "select", "demuxer"], default="segments"
    )
    parser.add_argument("--mode", choices=["copy", "encode"], default="copy")
    parser.add_argument("--video-map", default="0:v:0")
    parser.add_argument("--audio-map", default="0:a:0")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    ranges = read_subtitle_ranges(args.subtitles)
    if not ranges:
        sys.exit(f"No subtitle ranges found in {args.subtitles}")

    merged = merge_ranges(ranges, args.pre_pad, args.post_pad, args.merge_gap)
    source_duration = sum(end - start for start, end in ranges)
    merged_duration = sum(end - start for start, end in merged)
    print(f"Subtitle ranges: {len(ranges)}")
    print(f"Merged ranges:   {len(merged)}")
    print(f"Raw dialogue:    {format_duration(source_duration)}")
    print(f"Output approx:   {format_duration(merged_duration)}")

    if args.method == "segments":
        if args.mode == "copy":
            args.mode = "encode"
        parts_dir = args.parts_dir or args.output.with_suffix(".parts")
        render_segment_files(
            args.video,
            merged,
            args.output,
            parts_dir,
            args.video_map,
            args.audio_map,
            args.dry_run,
        )
        return
    if args.method == "select":
        if args.mode == "copy":
            args.mode = "encode"
        filter_path = args.filter_file or args.output.with_suffix(".select-filter.txt")
        write_select_filter(merged, filter_path, args.video_map, args.audio_map)
        print(f"Filter file:     {filter_path}")
        command = build_select_ffmpeg_command(args.video, filter_path, args.output)
    else:
        concat_path = args.concat_file or args.output.with_suffix(".ffconcat")
        write_concat_file(args.video, merged, concat_path)
        print(f"Concat file:     {concat_path}")
        command = build_ffmpeg_command(
            concat_path, args.output, args.mode, args.video_map, args.audio_map
        )
    print("ffmpeg command:")
    print(" ".join(shlex.quote(part) for part in command))
    if not args.dry_run:
        subprocess.run(command, check=True)


if __name__ == "__main__":
    main()
