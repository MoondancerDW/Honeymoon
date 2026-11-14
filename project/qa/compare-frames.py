"""Inventory matching frames and rank them for visual review."""
import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageStat


def compare(native, browser, poses, output):
    output.mkdir(parents=True, exist_ok=True)
    recorded = []
    for pose in poses:
        name = pose["id"]
        frames = []
        for directory in (native, browser):
            with Image.open(directory / (name + ".png")) as source:
                if source.size != (1280, 720):
                    raise ValueError(f"{name} has unexpected dimensions {source.size}")
                frames.append(source.convert("RGB").resize((320, 180), Image.Resampling.BOX))
        difference = ImageChops.difference(*frames)
        error = sum(ImageStat.Stat(difference).mean) / 3
        black = [sum(frame.convert("L").histogram()[:16]) / (320 * 180) for frame in frames]
        recorded.append({"id": name, "meanPixelDifference": round(error, 2),
                         "blackFractionDelta": round(black[1] - black[0], 3)})
    recorded.sort(key=lambda view: view["meanPixelDifference"], reverse=True)
    (output / "index.json").write_text(json.dumps(recorded, indent=2) + "\n", encoding="utf-8")

    by_id = {pose["id"]: pose for pose in poses}
    width, height = 320, 180
    row_height = height + 21
    columns = 2
    rows = 8
    for first in range(0, len(recorded), rows * columns):
        group = recorded[first:first + rows * columns]
        sheet = Image.new("RGB", (width * 2 * columns, row_height * ((len(group) + columns - 1) // columns)), "#172028")
        label = ImageDraw.Draw(sheet)
        for item, frame in enumerate(group):
            x, y = (item % columns) * width * 2, (item // columns) * row_height
            name = frame["id"]
            position = " / ".join(f"{component:g}" for component in by_id[name]["feet"])
            label.text((x + 5, y + 4), f"{name}   {position}   Minecraft | Honeymoon", fill="white")
            for j, directory in enumerate((native, browser)):
                with Image.open(directory / (name + ".png")) as source:
                    sheet.paste(source.resize((width, height), Image.Resampling.BOX), (x + j * width, y + 21))
        sheet.save(output / f"frames-{first // (rows * columns) + 1:03d}.jpg", quality=90)
    return len(recorded)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    for field in ("native", "browser", "output"):
        parser.add_argument(field, type=Path)
    args = parser.parse_args()
    poses = json.loads((args.browser / "poses.json").read_text(encoding="utf-8"))["poses"]
    print(f"Compared {compare(args.native, args.browser, poses, args.output)} frame pairs.")
