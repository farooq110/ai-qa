#!/usr/bin/env python3
"""Crop and annotate ProoflineQA docs screenshots (2x retina captures).

Reads raw full-viewport captures (/tmp/shots2x/*.png) plus element rects
(/tmp/shots2x-rects.json, CSS pixels at scale 2), crops regions of interest,
draws numbered amber markers, and writes final PNGs into the docs public dir.

Usage: python3 annotate_screenshot.py
"""
import json
import os
from PIL import Image, ImageDraw, ImageFont

SHOTS = "/tmp/shots2x"
RECTS = "/tmp/shots2x-rects.json"
OUT = "/home/hyperdev-solutions/Desktop/projects/desktop/agentic-qa/apps/user-docs/public/images/writing-test-steps"
ACCENT = (245, 158, 11)
DARK = (17, 17, 17)
S = 2  # device scale factor

FONT = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 26)

with open(RECTS) as f:
    data = json.load(f)
r = data["rects"]


def sx(box):
    """CSS-pixel rect -> device pixels (accepts w/h or width/height keys)."""
    if box is None:
        return None
    w = box.get("w", box.get("width"))
    h = box.get("h", box.get("height"))
    return {"x": box["x"] * S, "y": box["y"] * S, "w": w * S, "h": h * S}


def load(name):
    return Image.open(os.path.join(SHOTS, f"{name}.png")).convert("RGB")


def crop_abs(img, left, top, right, bottom):
    return img.crop((max(0, left), max(0, top), min(img.width, right), min(img.height, bottom)))


def crop_around(img, box, pad=14):
    b = sx(box)
    return crop_abs(img, int(b["x"] - pad), int(b["y"] - pad), int(b["x"] + b["w"] + pad), int(b["y"] + b["h"] + pad))


def badge(img, cx, cy, number):
    d = ImageDraw.Draw(img)
    r = 22
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT, outline=DARK, width=4)
    tb = d.textbbox((0, 0), str(number), font=FONT)
    d.text((cx - (tb[2] - tb[0]) / 2, cy - (tb[3] - tb[1]) / 2 - 2), str(number), font=FONT, fill=DARK)
    return img


def save(img, name):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    img.save(path, optimize=True)
    print(f"{name}: {img.width}x{img.height} -> {os.path.getsize(path) // 1024} KB")


def main():
    # 01 opening the editor — header band with the highlighted button
    img = load("shots-01-header")
    b = sx(r["new-manual-test"])
    save(crop_abs(img, 420, 40, 2880, int(b["y"] + b["h"] + 110)), "open-editor.png")

    # 02 full editor (tall viewport, modal over library)
    img = load("shots-02-editor-full")
    m = sx(r["editorModal"])
    save(crop_abs(img, int(m["x"] - 80), int(m["y"] - 50), int(m["x"] + m["w"] + 80), int(m["y"] + m["h"] + 50)), "editor-full.png")

    # 03 step anatomy — fieldset crop with numbered markers on row 2
    img = load("shots-13-worked-example")
    fs_box = sx(r["fieldset"])
    img = crop_around(img, r["fieldset"], pad=20)
    off = (int(fs_box["x"] - 20), int(fs_box["y"] - 20))
    c = {k: sx(v) for k, v in r["row2Children"].items()}
    row = sx(r["row2"])
    cy = row["y"] + row["h"] / 2 - off[1]
    badge(img, c["drag"]["x"] + 16 - off[0], cy, 1)
    badge(img, c["index"]["x"] + 22 - off[0], cy, 2)
    badge(img, c["action"]["x"] + 40 - off[0], c["action"]["y"] - off[1] - 8, 3)
    badge(img, c["target"]["x"] + 60 - off[0], c["target"]["y"] - off[1] - 8, 4)
    badge(img, (c["up"]["x"] + c["down"]["x"] + 52) / 2 - off[0], c["up"]["y"] + 26 - off[1], 5)
    badge(img, c["remove"]["x"] + 26 - off[0], c["remove"]["y"] + 26 - off[1], 6)
    save(img, "step-anatomy.png")

    # 04 action dropdown — row + open menu
    img = load("shots-04-action-dropdown")
    m = sx(r["action-dropdown"]["menu"])
    save(crop_abs(img, 560, int(m["y"] - 200), 2360, int(m["y"] + m["h"] + 50)), "action-dropdown.png")

    # 05 condition select — row + open menu
    img = load("shots-05-condition-select")
    m = sx(r["condMenu"]["condMenu"])
    save(crop_abs(img, 1400, int(m["y"] - 190), 2400, int(m["y"] + m["h"] + 50)), "assert-conditions.png")

    # 06 region fields — the assert color row
    img = load("shots-06-region-fields")
    save(crop_around(img, r["row4"], pad=32), "region-fields.png")

    # 07 region picker — modal area
    img = load("shots-07-region-picker")
    m = sx(r["pickerModal"])
    save(crop_abs(img, int(m["x"] - 40), int(m["y"] - 40), int(m["x"] + m["w"] + 40), int(m["y"] + m["h"] + 40)), "region-picker.png")

    # 08 credential chips
    img = load("shots-13-worked-example")
    save(crop_around(img, r["varsHint"], pad=24), "credential-chips.png")

    # 09 insert pill + add step
    img = load("shots-09-insert-add")
    save(crop_around(img, r["insertAdd"]["fieldset"], pad=52), "insert-add-step.png")

    # 10 drag reorder highlight
    img = load("shots-10-drag-over")
    save(crop_around(img, r["fieldset"], pad=52), "drag-reorder.png")

    # 11 record bar
    img = load("shots-13-worked-example")
    save(crop_around(img, r["recordBar"], pad=24), "record-bar.png")

    # 12 save footer
    img = load("shots-13-worked-example")
    save(crop_around(img, r["footer"], pad=24), "save-footer.png")

    # 13 worked example — clean fieldset
    img = load("shots-13-worked-example")
    save(crop_around(img, r["fieldset"], pad=20), "worked-example.png")


if __name__ == "__main__":
    main()
