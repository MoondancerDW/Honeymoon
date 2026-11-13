"""Build side-by-side local PNGs for the matched route."""
import argparse
import json
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


PROJECT = Path(__file__).resolve().parent.parent
BROWSER = PROJECT / "work" / "reference-comparison" / "browser"
TITLES = {
    "01-spawn": "Точка появления",
    "02-street": "Улица",
    "03-corner": "Поворот",
    "04-facade": "Фасад",
    "05-door": "Дверь",
    "06-armchair": "Интерьер",
}
BACKGROUND = "#151e22"
MUTED = "#bcc7ca"
INK = "#f2f4f4"


def font(size, bold=False):
    path = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts" / ("segoeuib.ttf" if bold else "segoeui.ttf")
    if path.exists():
        return ImageFont.truetype(str(path), size)
    return ImageFont.truetype("DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf", size)


def panel(images, labels, title, subheading, width):
    margin = 20
    gap = 12
    target = (width, round(width * 9 / 16))
    frame_top = 98
    image = Image.new("RGB", (2 * margin + len(images) * width + (len(images) - 1) * gap,
                              frame_top + target[1] + margin), BACKGROUND)
    draw = ImageDraw.Draw(image)
    draw.text((margin, 12), title, font=font(23, True), fill=INK)
    draw.text((margin, 45), subheading, font=font(14), fill=MUTED)
    for index, (path, label) in enumerate(zip(images, labels, strict=True)):
        with Image.open(path) as source:
            frame = source.convert("RGB")
        # Preserve the full view if legacy window dimensions differ from 16:9.
        frame.thumbnail(target, Image.Resampling.LANCZOS)
        left = margin + index * (width + gap)
        draw.text((left, 73), label, font=font(14, True), fill=INK)
        image.paste(frame, (left + (width - frame.width) // 2, frame_top + (target[1] - frame.height) // 2))
    return image


def render(legacy, after, before, output):
    poses = json.loads((after / "poses.json").read_text(encoding="utf-8"))["poses"]
    output.mkdir(parents=True, exist_ok=True)
    pair_labels = ["Minecraft 1.4.7", "Honeymoon в браузере"]
    pairs = []
    for pose in poses:
        identity = pose["id"]
        file = f"{identity}.png"
        title = f"{identity[:2]} · {TITLES[identity]}"
        position = " / ".join(f"{coordinate:g}" for coordinate in pose["feet"])
        heading = f"X / Y / Z  {position}   ·   поворот {pose['yaw']}°   ·   наклон {pose['pitch']}°"
        paths = [legacy / file, after / file]
        card = panel(paths, pair_labels, title, heading, 680)
        card.save(output / file)
        pairs.append(card)
        if before is not None:
            panel([paths[0], before / file, paths[1]], [pair_labels[0], "Браузер до", "Браузер после"],
                  title, heading, 520).save(output / f"{identity}-before-after.png")

    sheet = Image.new("RGB", (pairs[0].width, sum(card.height for card in pairs)), BACKGROUND)
    top = 0
    for card in pairs:
        sheet.paste(card, (0, top))
        top += card.height
    sheet.save(output / "route.png")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("legacy", type=Path)
    parser.add_argument("--after", type=Path, default=BROWSER / "after")
    parser.add_argument("--before", type=Path)
    parser.add_argument("--output", type=Path, default=BROWSER / "pairs")
    arguments = parser.parse_args()
    render(arguments.legacy, arguments.after, arguments.before, arguments.output)
