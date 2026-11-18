"""Build Honeymoon's altitude overview from the exported map and Vista tiles."""

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image


def build(vista, map_tiles, out):
    manifest = json.loads((vista / "manifest.json").read_text(encoding="utf-8"))
    if manifest["version"] != 2:
        raise ValueError("Vista version 2 is required")
    min_x, min_z, max_x, max_z = manifest["bounds"]
    west = math.floor(min_x / 4) * 64
    north = math.floor(min_z / 4) * 64
    east = math.ceil((max_x + 1) / 4) * 64
    south = math.ceil((max_z + 1) / 4) * 64
    field = np.zeros(((south - north) // 8, (east - west) // 8), dtype=np.uint16)
    for x, z in manifest["regions"]:
        raw = (vista / f"{x}.{z}.bin").read_bytes()
        cells = np.ndarray((66, 66), dtype="<u2", buffer=raw, offset=8, strides=(66 * 22, 22))
        tx, tz = x * 64 - west // 8, z * 64 - north // 8
        x0, z0 = max(0, tx), max(0, tz)
        x1, z1 = min(field.shape[1], tx + 64), min(field.shape[0], tz + 64)
        if x0 < x1 and z0 < z1:
            field[z0:z1, x0:x1] = cells[1+z0-tz:1+z1-tz, 1+x0-tx:1+x1-tx]

    rows, cols = field.shape[0] // 8 + 1, field.shape[1] // 8 + 1
    heights = np.zeros((rows, cols, 4), dtype=np.uint8)
    for z in range(rows):
        for x in range(cols):
            values = field[max(0, z*8-4):z*8+4, max(0, x*8-4):x*8+4]
            values = values[values > 0]
            if values.size:
                height = min(255, round(np.median(values) / 8))
                heights[z, x] = (height, height, height, 255)

    colors = Image.new("RGB", (field.shape[1], field.shape[0]), "#687c7b")
    for z in range(north // 2048, math.ceil(south / 2048)):
        for x in range(west // 2048, math.ceil(east / 2048)):
            tile = map_tiles / "3" / f"{x}_{z}.png"
            if tile.exists():
                with Image.open(tile).convert("RGBA") as layer:
                    colors.paste(layer.convert("RGB"), (x*256-west//8, z*256-north//8), layer)

    out.mkdir(parents=True, exist_ok=True)
    Image.fromarray(heights).save(out / "altitude-heights.png", optimize=True)
    colors.save(out / "altitude-colors.webp", quality=84, method=4)
    descriptor = {"vistaHash": manifest["hash"], "west": west, "north": north, "east": east,
                  "south": south, "step": 64, "columns": cols, "rows": rows}
    (out / "altitude-map-data.mjs").write_text("export default " + json.dumps(descriptor) + ";\n",
                                               encoding="utf-8")
    print(json.dumps(descriptor))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vista", type=Path, required=True)
    parser.add_argument("--tiles", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    build(args.vista, args.tiles, args.out)
