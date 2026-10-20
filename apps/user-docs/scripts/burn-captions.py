#!/usr/bin/env python3
"""Burn tutorial captions into the recorded walkthrough and transcode to MP4.

Maps the wall-clock action marks (recorded during capture) onto the video
timeline, then renders one caption per segment with ffmpeg drawtext.
"""
import json
import subprocess
import os

RAW = sorted(
    (f for f in os.listdir("/tmp/tutorial-video") if f.endswith(".webm")),
    key=lambda f: os.path.getmtime(f"/tmp/tutorial-video/{f}"),
)[-1]
RAW_PATH = f"/tmp/tutorial-video/{RAW}"
OUT_MP4 = "/home/hyperdev-solutions/Desktop/projects/desktop/agentic-qa/apps/user-docs/public/videos/writing-test-steps.mp4"
POSTER = "/home/hyperdev-solutions/Desktop/projects/desktop/agentic-qa/apps/user-docs/public/videos/writing-test-steps-poster.jpg"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

marks = {m["label"]: m["t"] for m in json.load(open("/tmp/tutorial-video/marks.json"))}

probe = subprocess.run(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of",
     "default=noprint_wrappers=1:nokey=1", RAW_PATH],
    capture_output=True, text=True)
duration = float(probe.stdout.strip())

# wall-clock totals: pre-t0 (page load + initial pause) and the closing pause
PRE = 2.0
POST = 3.6
wall_total = marks["save"] + POST + PRE
scale = duration / wall_total
vt = lambda wall_t: max(0.0, (wall_t + PRE) * scale)

def seg(a, b):
    return vt(marks[a]), vt(marks[b])

captions = [
    (seg("start", "title")[0], seg("start", "title")[1], "Open Test cases and click New manual test"),
    (seg("title", "meta")[0], seg("meta", "step1")[0], "Give the test a clear title"),
    (seg("meta", "step1")[0], seg("meta", "step1")[1], "Add the capability and the starting page"),
    (seg("step1", "dropdown-open")[0], seg("step1", "dropdown-open")[1], "Step 1: navigate - where the browser goes"),
    (seg("dropdown-open", "step2")[0], seg("dropdown-open", "step2")[1], "Pick the click action"),
    (seg("step2", "step3")[0], seg("step2", "step3")[1] * 0.55 + seg("step2", "step3")[0] * 0.45, "Step 2: click \"Add to cart\""),
    (seg("step2", "step3")[1] * 0.55 + seg("step2", "step3")[0] * 0.45, seg("step3", "conditions")[0], "Step 3: assert - check something on screen"),
    (seg("step3", "conditions")[1], seg("conditions", "reorder")[0], "Choose a condition - visible by default"),
    (seg("reorder", "expected")[0], seg("reorder", "expected")[1], "Reorder steps until the flow is right"),
    (seg("expected", "save")[0], seg("expected", "save")[1], "Describe the expected result"),
    (seg("save", "save")[0] + 0.15, duration - 0.2, "Save - the new test waits for review"),
]
captions[0] = (0.2, captions[0][1], captions[0][2])

filters = []
for start, end, text in captions:
    text = text.replace("'", r"\'").replace(":", "\\:")
    filters.append(
        f"drawtext=fontfile={FONT}:text='{text}':fontsize=30:fontcolor=white:"
        f"box=1:boxcolor=black@0.65:boxborderw=18:x=(w-text_w)/2:y=h-th-48:"
        f"enable='between(t,{start:.2f},{end:.2f})'"
    )

vf = ",".join(filters)
cmd = [
    "ffmpeg", "-y", "-v", "error", "-i", RAW_PATH,
    "-vf", vf,
    "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", "-an", OUT_MP4,
]
subprocess.run(cmd, check=True)

subprocess.run([
    "ffmpeg", "-y", "-v", "error", "-ss", str(vt(marks["step1"]) + 1.5),
    "-i", OUT_MP4, "-frames:v", "1", "-q:v", "4", POSTER,
], check=True)

print("mp4:", os.path.getsize(OUT_MP4) // 1024, "KB, duration:", duration)
print("poster:", os.path.getsize(POSTER) // 1024, "KB")
