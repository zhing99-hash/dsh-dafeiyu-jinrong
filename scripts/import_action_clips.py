#!/usr/bin/env python3
"""Append a curated dsh-pet action pack to the existing frame set.

Unlike ``import_dshpet_webm.py`` this tool does not rebuild the whole asset
tree: it reuses the committed global crop (the union alpha box of the base 16
clips), encodes only the new sources with that same crop, and appends their
manifest entries. That keeps every existing frame byte-identical while adding
in-place actions that fit the same character anchor.

Usage:
    python scripts/import_action_clips.py \
        --source <dir with the 8 .webm files> \
        --ffmpeg <ffmpeg.exe> \
        --out <repository root>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path

FPS = 24
FRAME_MS = 42
QUALITY = 68
UPSTREAM_COMMIT = "549fff2ea33c2acfb16612c76912c6137da4a758"

# (clip key, source file, loop, (start_sec, end_sec) or None)
SELECTION = [
    ("idle_hum", "悠闲哼歌.webm", False, None),
    ("idle_mirror", "照镜子.webm", False, None),
    ("idle_fan", "摇扇纳凉.webm", False, None),
    ("play_cube", "原地专心玩魔方.webm", False, None),
    ("play_gift", "拆礼物.webm", False, None),
    ("click_happy", "点击回应-开心跃动.webm", False, None),
    ("click_shy", "点击回应-害羞惊讶.webm", False, None),
    ("click_angry", "点击回应-傲娇生气.webm", False, None),
]
IDLE_MICRO = ["idle_hum", "idle_mirror", "idle_fan", "play_cube", "play_gift"]


def encode(ffmpeg: Path, source: Path, crop: list[int], target: Path) -> list[Path]:
    target.mkdir(parents=True, exist_ok=True)
    for stale in target.glob("*.webp"):
        stale.unlink()
    command = [
        str(ffmpeg), "-v", "error", "-c:v", "libvpx-vp9", "-i", str(source),
        "-vf", f"fps={FPS},crop={crop[2]}:{crop[3]}:{crop[0]}:{crop[1]}",
        "-c:v", "libwebp", "-lossless", "0", "-q:v", str(QUALITY), "-compression_level", "4",
        str(target / "frame_%03d.webp"),
    ]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed for {source.name}:\n{result.stderr[-2000:]}")
    return sorted(target.glob("frame_*.webp"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--ffmpeg", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    root = args.out.resolve()
    manifest_path = root / "assets" / "pet-manifest.json"
    pet_root = root / "assets" / "pet"
    if not manifest_path.is_file():
        raise SystemExit(f"missing manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    crop = manifest.get("assetSource", {}).get("crop")
    if not isinstance(crop, list) or len(crop) != 4:
        raise SystemExit("manifest has no global crop; run import_dshpet_webm.py first")

    missing = [name for _, name, _, _ in SELECTION if not (args.source / name).is_file()]
    if missing:
        raise SystemExit(f"missing source clips: {missing}")

    for key, name, loop, window in SELECTION:
        source = args.source / name
        target = pet_root / key
        frames = encode(args.ffmpeg, source, crop, target)
        if not frames:
            raise SystemExit(f"no frames encoded for {name}")
        start = int(round((window[0] if window else 0.0) * FPS))
        end = int(round((window[1] if window else len(frames) / FPS) * FPS))
        chosen = frames[start:end]
        size_kb = sum(path.stat().st_size for path in chosen) // 1024
        clip_frames = []
        for index, frame in enumerate(chosen, start=1):
            renamed = target / f"{key}_{index:03d}.webp"
            frame.rename(renamed)
            clip_frames.append(f"{key}/{renamed.name}")
        manifest["clips"][key] = {
            "frames": clip_frames,
            "frameMs": FRAME_MS,
            "loop": loop,
            "source": {
                "file": name,
                "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "commit": UPSTREAM_COMMIT,
                "startFrame": start,
                "endFrame": end,
                "frameCount": len(frames),
            },
        }
        print(f"clip {key}: {len(clip_frames)} frames, {size_kb} KB")

    existing = list(manifest.get("idleMicroClips") or [])
    manifest["idleMicroClips"] = list(dict.fromkeys([*existing, *IDLE_MICRO]))
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    total_mb = sum(path.stat().st_size for path in pet_root.rglob("*.webp")) // (1024 * 1024)
    print(f"manifest written; total frame size: {total_mb} MB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
