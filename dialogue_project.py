#!/usr/bin/env python3
import argparse
from collections import Counter
import json
import re
import shlex
import subprocess
from pathlib import Path


SRT_TIME_RE = re.compile(
    r"(?P<start>\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*"
    r"(?P<end>\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})"
)
ASS_TAG_RE = re.compile(r"\{[^}]*\}")
WORD_RE = re.compile(r"[A-Za-zÄÖÜäöüß]+")
REPEATED_CHAR_RE = re.compile(r"([A-Za-zÄÖÜäöüß])\1{5,}", re.IGNORECASE)
VOCAL_TOKENS = {
    "a",
    "aa",
    "aaa",
    "ah",
    "aha",
    "äh",
    "eh",
    "ha",
    "haha",
    "hahaha",
    "hm",
    "hmm",
    "hmmm",
    "oh",
    "oho",
    "uh",
    "uah",
    "ähm",
}
NOISE_TOKENS = {
    "aua",
    "bam",
    "bang",
    "bonk",
    "boom",
    "bumm",
    "crash",
    "knall",
    "peng",
    "puff",
}
SONG_HINTS = {
    "sing",
    "singen",
    "song",
    "chorus",
    "refrain",
    "we",
    "ll",
    "stick",
    "together",
}
DEFAULT_KEEP_SOURCES = {"dialogue", "mixed"}
SOURCE_ALIASES = {
    "dialog": "dialogue",
}


def ordered_unique(values):
    seen = set()
    result = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def parse_timestamp(value):
    value = value.strip().replace(",", ".")
    hours, minutes, seconds = value.split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def parse_ass_timestamp(value):
    hours, minutes, seconds = value.strip().split(":")
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


def clean_text(lines):
    text = " ".join(line.strip() for line in lines if line.strip())
    text = ASS_TAG_RE.sub("", text)
    return re.sub(r"\s+", " ", text).strip()


def classify_cue(cue):
    text = cue.get("text", "")
    duration = max(0.001, cue["end"] - cue["start"])
    tokens = WORD_RE.findall(text.lower())
    token_count = len(tokens)
    unique_tokens = set(tokens)
    repeated_char = bool(REPEATED_CHAR_RE.search(text))
    counts = {token: tokens.count(token) for token in unique_tokens}
    most_common = max(counts.values(), default=0)
    most_common_token = next(
        (token for token, count in counts.items() if count == most_common), ""
    )
    repeated_token = (
        token_count >= 6
        and most_common >= 4
        and most_common / token_count >= 0.45
        and len(most_common_token) <= 5
    )
    word_density = token_count / duration
    low_density_long = duration >= 8.0 and word_density < 0.35
    long_cue = duration >= 12.0
    vocal_only = bool(tokens) and all(token in VOCAL_TOKENS for token in tokens)
    noise_only = bool(tokens) and all(token in NOISE_TOKENS for token in tokens)
    likely_song = (
        duration >= 8.0
        and len(unique_tokens & SONG_HINTS) >= 2
        and token_count >= 8
    )

    reasons = []
    if long_cue:
        reasons.append("long-cue")
    if repeated_char:
        reasons.append("repeated-character")
    if repeated_token:
        reasons.append(f"repeated-token:{most_common_token}")
    if low_density_long:
        reasons.append("low-word-density")
    if vocal_only:
        reasons.append("vocal-tokens-only")
    if noise_only:
        reasons.append("noise-tokens-only")
    if likely_song:
        reasons.append("song-keywords")

    if repeated_char or vocal_only:
        cue_class = "vocalization"
    elif noise_only:
        cue_class = "noise"
    elif likely_song:
        cue_class = "song"
    elif low_density_long or (long_cue and repeated_token):
        cue_class = "suspect"
    else:
        cue_class = "dialogue"

    cue["class"] = cue_class
    cue["review"] = bool(reasons and (cue_class != "dialogue" or long_cue))
    cue["reviewReasons"] = reasons
    cue["metrics"] = {
        "duration": round(duration, 3),
        "wordCount": token_count,
        "uniqueWordCount": len(unique_tokens),
        "wordDensity": round(word_density, 3),
        "mostCommonToken": most_common_token,
        "mostCommonTokenCount": most_common,
    }
    return cue


def short_repetition_candidate(cue):
    metrics = cue.get("metrics", {})
    return (
        cue.get("class") == "dialogue"
        and metrics.get("duration", 0) <= 4.0
        and 1 <= metrics.get("wordCount", 0) <= 8
    )


def repetition_fingerprint(cue):
    return " ".join(WORD_RE.findall(cue.get("text", "").lower()))


def mark_repeated_cue_run(cue, reason):
    cue["class"] = "suspect"
    cue["review"] = True
    cue.setdefault("reviewReasons", [])
    if reason not in cue["reviewReasons"]:
        cue["reviewReasons"].append(reason)


def classify_repeated_cue_runs(cues):
    index = 0
    while index < len(cues):
        if not short_repetition_candidate(cues[index]):
            index += 1
            continue

        run_start = index
        index += 1
        while index < len(cues):
            gap = cues[index]["start"] - cues[index - 1]["end"]
            if gap > 0.4 or not short_repetition_candidate(cues[index]):
                break
            index += 1
        run = cues[run_start:index]

        counts = Counter(
            fingerprint for cue in run if (fingerprint := repetition_fingerprint(cue))
        )
        repeated_fingerprints = {
            fingerprint for fingerprint, count in counts.items() if count >= 3
        }
        repeated_cues = [
            cue for cue in run if repetition_fingerprint(cue) in repeated_fingerprints
        ]
        repeated_duration = sum(cue["end"] - cue["start"] for cue in repeated_cues)
        if (
            len(repeated_fingerprints) <= 3
            and len(repeated_cues) >= 6
            and repeated_duration >= 10.0
        ):
            for cue in repeated_cues:
                mark_repeated_cue_run(cue, "repeated-cue-run")


def classify_cues(cues):
    classified = []
    sorted_cues = sorted(cues, key=lambda item: (item["start"], item["end"]))
    for index, cue in enumerate(sorted_cues, start=1):
        cue = dict(cue)
        cue["id"] = f"cue-{index:04d}"
        classified.append(classify_cue(cue))
    classify_repeated_cue_runs(classified)
    return classified


def read_srt_cues(path):
    cues = []
    block = []
    for line in path.read_text(encoding="utf-8-sig", errors="replace").splitlines():
        if line.strip():
            block.append(line)
            continue
        if block:
            cues.extend(parse_srt_block(block))
            block = []
    if block:
        cues.extend(parse_srt_block(block))
    return cues


def parse_srt_block(block):
    for index, line in enumerate(block):
        match = SRT_TIME_RE.search(line)
        if not match:
            continue
        start = parse_timestamp(match.group("start"))
        end = parse_timestamp(match.group("end"))
        if end <= start:
            return []
        return [{"start": start, "end": end, "text": clean_text(block[index + 1 :])}]
    return []


def split_ass_dialogue(line, field_count):
    payload = line.split(":", 1)[1].lstrip()
    return payload.split(",", field_count - 1)


def read_ass_cues(path):
    cues = []
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
                text = parts[fields.index("text")]
            except (ValueError, IndexError):
                continue
            if end > start:
                cues.append({"start": start, "end": end, "text": clean_text([text])})
    return cues


def read_cues(path):
    suffix = path.suffix.lower()
    if suffix == ".srt":
        return read_srt_cues(path)
    if suffix in {".ass", ".ssa"}:
        return read_ass_cues(path)
    raise ValueError(f"Unsupported subtitle format: {path.suffix}")


def make_segments(cues, pre_pad, post_pad, merge_gap):
    segments = []
    for cue in cues:
        start = max(0.0, cue["start"] - pre_pad)
        end = cue["end"] + post_pad
        if not segments or start - segments[-1]["end"] > merge_gap:
            segments.append(
                {
                    "id": f"seg-{len(segments) + 1:04d}",
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "enabled": True,
                    "source": "dialogue",
                    "text": cue["text"],
                    "cues": [cue],
                }
            )
        else:
            current = segments[-1]
            current["end"] = round(max(current["end"], end), 3)
            current["cues"].append(cue)
            current["text"] = clean_text([current["text"], cue["text"]])
        update_segment_metadata(segments[-1])
    return segments


def source_for_classes(classes):
    if classes == ["dialogue"]:
        return "dialogue"
    if "dialogue" in classes:
        return "mixed"
    if len(classes) == 1:
        return classes[0]
    return "non-dialogue"


def update_segment_metadata(segment):
    cues = segment.get("cues", [])
    incidental_cues = segment.get("incidentalCues", [])
    all_cues = cues + incidental_cues
    classes = ordered_unique(cue.get("class", "dialogue") for cue in cues)
    if incidental_cues:
        classes = ordered_unique(cue.get("class", "dialogue") for cue in all_cues)
    reasons = ordered_unique(
        reason
        for cue in all_cues
        for reason in cue.get("reviewReasons", [])
    )
    segment["cueIds"] = [cue.get("id") for cue in cues if cue.get("id")]
    segment["incidentalCueIds"] = [
        cue.get("id") for cue in incidental_cues if cue.get("id")
    ]
    segment["cueCount"] = len(cues)
    segment["incidentalCueCount"] = len(incidental_cues)
    segment["classes"] = classes
    segment["review"] = any(cue.get("review", False) for cue in all_cues)
    segment["reviewReasons"] = reasons
    segment["duration"] = round(segment["end"] - segment["start"], 3)
    segment["source"] = source_for_classes(classes)


def parse_csv_or_all(value, aliases=None):
    if value.lower() == "all":
        return None
    aliases = aliases or {}
    return {
        aliases.get(item.strip(), item.strip())
        for item in value.split(",")
        if item.strip()
    }


def parse_keep_sources(value):
    return parse_csv_or_all(value, SOURCE_ALIASES)


def split_cues_by_class(cues, keep_classes):
    if keep_classes is None:
        return cues, []
    kept = [cue for cue in cues if cue.get("class", "dialogue") in keep_classes]
    dropped = [cue for cue in cues if cue.get("class", "dialogue") not in keep_classes]
    return kept, dropped


def annotate_incidental_cues(segments, dropped_cues, min_overlap):
    for segment in segments:
        incidental = []
        for cue in dropped_cues:
            overlap = min(cue["end"], segment["end"]) - max(cue["start"], segment["start"])
            if overlap >= min_overlap:
                cue = dict(cue)
                cue["includedOverlap"] = round(overlap, 3)
                incidental.append(cue)
        if incidental:
            segment["incidentalCues"] = incidental
        update_segment_metadata(segment)


def apply_keep_policy(project, keep_sources):
    if keep_sources is None:
        return
    for segment in project["segments"]:
        if segment.get("source") in keep_sources:
            segment["enabled"] = True
        elif segment.get("source") != "manual":
            segment["enabled"] = False


def enabled_segments(project):
    return [
        segment
        for segment in project["segments"]
        if segment.get("enabled", True) and segment["end"] > segment["start"]
    ]


def ffconcat_quote(path):
    return "'" + str(path).replace("'", "'\\''") + "'"


def write_concat(video_path, segments, concat_path):
    video_path = Path(video_path).resolve()
    with concat_path.open("w", encoding="utf-8") as handle:
        handle.write("ffconcat version 1.0\n")
        for segment in segments:
            handle.write(f"file {ffconcat_quote(video_path)}\n")
            handle.write(f"inpoint {float(segment['start']):.3f}\n")
            handle.write(f"outpoint {float(segment['end']):.3f}\n")


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


def render_segment_files(video_path, segments, output_path, parts_dir, video_map, audio_map, dry_run):
    parts_dir.mkdir(parents=True, exist_ok=True)
    part_paths = []
    for index, segment in enumerate(segments, start=1):
        part_path = parts_dir / f"part-{index:04d}.mp4"
        part_paths.append(part_path)
        start = float(segment["start"])
        end = float(segment["end"])
        print(
            f"Rendering segment {index}/{len(segments)}: {start:.3f} -> {end:.3f}",
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

    print(f"Parts dir:     {parts_dir}")
    print(f"Parts concat:  {concat_path}")
    command = build_concat_parts_command(concat_path, output_path)
    print("ffmpeg command:")
    print(" ".join(shlex.quote(part) for part in command))
    if not dry_run:
        subprocess.run(command, check=True)


def format_duration(seconds):
    seconds = int(round(seconds))
    hours, seconds = divmod(seconds, 3600)
    minutes, seconds = divmod(seconds, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}"


def format_timestamp(seconds):
    whole = int(seconds)
    millis = int(round((seconds - whole) * 1000))
    if millis == 1000:
        whole += 1
        millis = 0
    hours, whole = divmod(whole, 3600)
    minutes, secs = divmod(whole, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millis:03d}"


def preview(text, limit=100):
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def write_project(args):
    cues = classify_cues(read_cues(args.subtitles))
    keep_cue_classes = parse_csv_or_all(args.keep_cue_classes)
    kept_cues, dropped_cues = split_cues_by_class(cues, keep_cue_classes)
    segments = make_segments(kept_cues, args.pre_pad, args.post_pad, args.merge_gap)
    annotate_incidental_cues(segments, dropped_cues, args.incidental_min_overlap)
    keep_sources = parse_keep_sources(args.keep_sources)
    project = {
        "version": 2,
        "video": str(args.video.resolve()),
        "subtitle": str(args.subtitles.resolve()),
        "language": args.language,
        "prePad": args.pre_pad,
        "postPad": args.post_pad,
        "mergeGap": args.merge_gap,
        "cueKeepClasses": (
            sorted(keep_cue_classes) if keep_cue_classes is not None else "all"
        ),
        "keepSources": sorted(keep_sources) if keep_sources is not None else "all",
        "cueCount": len(cues),
        "keptCueCount": len(kept_cues),
        "droppedCueCount": len(dropped_cues),
        "droppedCues": dropped_cues,
        "segments": segments,
    }
    apply_keep_policy(project, keep_sources)
    args.output.write_text(
        json.dumps(project, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print_stats(project)
    print(f"Project: {args.output}")
    if args.review_report:
        lines = build_review_lines(project, args.review_limit)
        args.review_report.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"Review:  {args.review_report}")


def iter_project_cues(project):
    seen = set()
    for segment in project["segments"]:
        for cue in segment.get("cues", []) + segment.get("incidentalCues", []):
            cue_id = cue.get("id") or (cue.get("start"), cue.get("end"), cue.get("text"))
            if cue_id in seen:
                continue
            seen.add(cue_id)
            yield cue
    for cue in project.get("droppedCues", []):
        cue_id = cue.get("id") or (cue.get("start"), cue.get("end"), cue.get("text"))
        if cue_id in seen:
            continue
        seen.add(cue_id)
        yield cue


def print_stats(project):
    segments = project["segments"]
    enabled = enabled_segments(project)
    enabled_ids = {id(segment) for segment in enabled}
    disabled = [segment for segment in segments if id(segment) not in enabled_ids]
    duration = sum(segment["end"] - segment["start"] for segment in enabled)
    cues = list(iter_project_cues(project))
    cue_classes = Counter(cue.get("class", "dialogue") for cue in cues)
    source_counts = Counter(segment.get("source", "unknown") for segment in segments)
    disabled_sources = Counter(segment.get("source", "unknown") for segment in disabled)
    review_cues = [cue for cue in cues if cue.get("review")]
    review_segments = [segment for segment in project["segments"] if segment.get("review")]
    print(f"Segments:      {len(enabled)} enabled / {len(segments)} total")
    print(f"Output approx: {format_duration(duration)}")
    print(f"Dropped segs:  {len(disabled)}")
    print(f"Cues:          {len(cues)}")
    if "keptCueCount" in project or "droppedCueCount" in project:
        print(
            f"Cue filter:    {project.get('keptCueCount', 0)} kept / "
            f"{project.get('droppedCueCount', 0)} dropped"
        )
    print(f"Review cues:   {len(review_cues)}")
    print(f"Review segs:   {len(review_segments)}")
    if source_counts:
        source_summary = ", ".join(
            f"{name}={count}" for name, count in sorted(source_counts.items())
        )
        print(f"Sources:       {source_summary}")
    if disabled_sources:
        drop_summary = ", ".join(
            f"{name}={count}" for name, count in sorted(disabled_sources.items())
        )
        print(f"Dropped srcs:  {drop_summary}")
    if cue_classes:
        class_summary = ", ".join(
            f"{name}={count}" for name, count in sorted(cue_classes.items())
        )
        print(f"Cue classes:   {class_summary}")


def build_review_lines(project, limit):
    segments = [
        segment
        for segment in project["segments"]
        if segment.get("review")
        or any(cue.get("review") for cue in segment.get("cues", []))
    ]
    total = len(segments)
    if limit is not None:
        segments = segments[:limit]

    lines = [
        f"Project: {project.get('video', '')}",
        f"Review segments: {total}",
        f"Dropped cues: {project.get('droppedCueCount', len(project.get('droppedCues', [])))}",
        "",
    ]
    for segment in segments:
        reasons = ", ".join(segment.get("reviewReasons", [])) or "review"
        classes = ", ".join(segment.get("classes", [])) or "dialogue"
        state = "enabled" if segment.get("enabled", True) else "dropped"
        duration = segment.get("duration", round(segment["end"] - segment["start"], 3))
        lines.append(
            f"{segment['id']} {format_timestamp(segment['start'])} -> "
            f"{format_timestamp(segment['end'])} "
            f"{duration:.3f}s {segment.get('source', 'unknown')} {state} "
            f"{classes} [{reasons}]"
        )
        segment_cues = [
            ("cue", cue) for cue in segment.get("cues", [])
        ] + [
            ("incidental", cue) for cue in segment.get("incidentalCues", [])
        ]
        for cue_kind, cue in segment_cues:
            if not cue.get("review") and cue.get("class", "dialogue") == "dialogue":
                continue
            cue_reasons = ", ".join(cue.get("reviewReasons", [])) or "review"
            lines.append(
                f"  {cue_kind} {cue.get('id', 'cue')} {format_timestamp(cue['start'])} -> "
                f"{format_timestamp(cue['end'])} {cue.get('class', 'dialogue')} "
                f"[{cue_reasons}] {preview(cue.get('text', ''))}"
            )
        lines.append("")

    if limit is not None and total > limit:
        lines.append(f"... {total - limit} more review segments not shown")
        lines.append("")

    incidental_ids = {
        cue.get("id")
        for segment in project["segments"]
        for cue in segment.get("incidentalCues", [])
        if cue.get("id")
    }
    dropped_cues = [
        cue for cue in project.get("droppedCues", []) if cue.get("id") not in incidental_ids
    ]
    if limit is not None:
        shown_dropped = dropped_cues[:limit]
    else:
        shown_dropped = dropped_cues
    if shown_dropped:
        lines.append("Dropped cue samples:")
        for cue in shown_dropped:
            cue_reasons = ", ".join(cue.get("reviewReasons", [])) or "filtered-class"
            lines.append(
                f"  {cue.get('id', 'cue')} {format_timestamp(cue['start'])} -> "
                f"{format_timestamp(cue['end'])} {cue.get('class', 'dialogue')} "
                f"[{cue_reasons}] {preview(cue.get('text', ''))}"
            )
        if limit is not None and len(dropped_cues) > limit:
            lines.append(f"... {len(dropped_cues) - limit} more dropped cues not shown")
    return lines


def review_project(args):
    project = json.loads(args.project.read_text(encoding="utf-8"))
    lines = build_review_lines(project, args.limit)
    if args.output:
        args.output.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"Review: {args.output}")
    else:
        print("\n".join(lines))


def render_project(args):
    project = json.loads(args.project.read_text(encoding="utf-8"))
    video_path = args.video or Path(project["video"])
    segments = enabled_segments(project)
    if args.method == "segments":
        parts_dir = args.parts_dir or args.output.with_suffix(".parts")
        print_stats(project)
        render_segment_files(
            video_path,
            segments,
            args.output,
            parts_dir,
            args.video_map,
            args.audio_map,
            args.dry_run,
        )
        return

    concat_path = args.concat_file or args.output.with_suffix(".ffconcat")
    write_concat(video_path, segments, concat_path)
    print_stats(project)
    print(f"Concat file:   {concat_path}")
    command = build_ffmpeg_command(
        concat_path, args.output, args.mode, args.video_map, args.audio_map
    )
    print("ffmpeg command:")
    print(" ".join(shlex.quote(part) for part in command))
    if not args.dry_run:
        subprocess.run(command, check=True)


def main():
    parser = argparse.ArgumentParser(description="Create and render dialogue edit projects.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    create = subparsers.add_parser("create", help="Create editable JSON from subtitles.")
    create.add_argument("video", type=Path)
    create.add_argument("subtitles", type=Path)
    create.add_argument("output", type=Path)
    create.add_argument("--language", default="ger")
    create.add_argument("--pre-pad", type=float, default=0.3)
    create.add_argument("--post-pad", type=float, default=0.5)
    create.add_argument("--merge-gap", type=float, default=1.0)
    create.add_argument("--incidental-min-overlap", type=float, default=0.75)
    create.add_argument(
        "--keep-cue-classes",
        default="dialogue",
        help="Comma-separated cue classes used to build ranges, or 'all'.",
    )
    create.add_argument(
        "--keep-sources",
        default="dialogue,mixed",
        help="Comma-separated segment sources to keep, or 'all'.",
    )
    create.add_argument("--review-report", type=Path)
    create.add_argument("--review-limit", type=int, default=None)
    create.set_defaults(func=write_project)

    stats = subparsers.add_parser("stats", help="Print project stats.")
    stats.add_argument("project", type=Path)
    stats.set_defaults(
        func=lambda args: print_stats(json.loads(args.project.read_text(encoding="utf-8")))
    )

    review = subparsers.add_parser("review", help="Print suspicious transcript cues.")
    review.add_argument("project", type=Path)
    review.add_argument("--limit", type=int, default=50)
    review.add_argument("--output", type=Path)
    review.set_defaults(func=review_project)

    render = subparsers.add_parser("render", help="Render an editable JSON project.")
    render.add_argument("project", type=Path)
    render.add_argument("output", type=Path)
    render.add_argument("--video", type=Path)
    render.add_argument("--concat-file", type=Path)
    render.add_argument("--parts-dir", type=Path)
    render.add_argument("--method", choices=["segments", "demuxer"], default="segments")
    render.add_argument("--mode", choices=["copy", "encode"], default="encode")
    render.add_argument("--video-map", default="0:v:0")
    render.add_argument("--audio-map", default="0:a:0")
    render.add_argument("--dry-run", action="store_true")
    render.set_defaults(func=render_project)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
