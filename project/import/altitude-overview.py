"""Build Honeymoon's altitude overview from the exported map and Vista tiles."""

import argparse
import json
import math
from pathlib import Path

import numpy as np
from PIL import Image


TILE_PIXELS = 256
VISTA_STEP = 8
RELIEF_STEP = 32
COLOR_STEP = 4
DETAIL_STEP = 2
# Keep one sharper texture over Ponyville and the adjoining settlements.
DETAIL_BOUNDS = (-1600, -2048, 1600, 960)
SURFACE = np.dtype({"names": ["height", "tile", "tint", "loft", "mask"],
                    "formats": ["<u2", "<u2", ("u1", 3), "<u2", "<u2"],
                    "offsets": [0, 2, 6, 9, 20], "itemsize": 22})


def ground_palette(atlas):
    with Image.open(atlas) as source:
        pixels = np.asarray(source.convert("RGBA"), dtype=np.float32)
    if pixels.shape[1] != 64 * 16 or pixels.shape[0] % 16:
        raise ValueError("Invalid Honeymoon terrain atlas")
    tiles = pixels.reshape((-1, 16, 64, 16, 4))
    alpha = tiles[..., 3:]
    summed = (tiles[..., :3] * alpha).sum(axis=(1, 3))
    return (summed / np.maximum(1, alpha.sum(axis=(1, 3)))).reshape((-1, 3))


def unproject_lofts(layer, height_tile, rect, x_coords, z_coords, field, palette, pixel_step):
    samples = field[np.ix_(z_coords // VISTA_STEP, x_coords // VISTA_STEP)]
    possible = np.zeros(samples.shape, dtype=bool)
    for dz in range(0, pixel_step, 2):
        for dx in range(0, pixel_step, 2):
            x_bit = ((x_coords + dx) % VISTA_STEP) // 2
            z_bit = ((z_coords + dz) % VISTA_STEP) // 2
            bit = 1 << (x_bit[None, :] + 4 * z_bit[:, None])
            possible |= (samples["mask"] & bit) != 0
    if not possible.any() or not height_tile.exists():
        return layer, 0
    with Image.open(height_tile) as heights:
        source = np.asarray(heights.convert("RGBA").crop(rect))
    floor = samples["height"].astype(np.int32)
    loft = samples["loft"].astype(np.int32)
    top = (source[..., 0].astype(np.int32) + 1) * 8
    # The source image paints the highest block straight down onto X/Z. The Vista
    # floor is instead below detached roofs, ships and bridges. Use its material
    # where the source texture would project a second copy onto the terrain.
    mask = possible & (floor > 0) & (source[..., 3] > 0) & (samples["tile"] < len(palette))
    mask &= top - floor >= np.maximum(8 * 8, (loft - floor) // 4)
    pixels = np.array(layer)
    pixels[mask, :3] = np.rint(palette[samples["tile"][mask]] * samples["tint"][mask] / 255).astype(np.uint8)
    return Image.fromarray(pixels), int(mask.sum())


def paint_tiles(colors, map_tiles, bounds, blocks_per_pixel, field, field_origin, palette):
    west, north, east, south = bounds
    field_west, field_north = field_origin
    span = TILE_PIXELS * blocks_per_pixel
    level = blocks_per_pixel.bit_length() - 1
    projected_pixels = 0
    for z in range(north // span, math.ceil(south / span)):
        for x in range(west // span, math.ceil(east / span)):
            filename = f"{x}_{z}.png"
            tile = map_tiles / str(level) / filename
            if not tile.exists():
                continue
            ox, oz = (x * span - west) // blocks_per_pixel, (z * span - north) // blocks_per_pixel
            left, top = max(0, -ox), max(0, -oz)
            right, bottom = min(TILE_PIXELS, colors.width - ox), min(TILE_PIXELS, colors.height - oz)
            rect = (left, top, right, bottom)
            xs = x * span + np.arange(left, right) * blocks_per_pixel - field_west
            zs = z * span + np.arange(top, bottom) * blocks_per_pixel - field_north
            with Image.open(tile) as source:
                if source.size != (TILE_PIXELS, TILE_PIXELS):
                    raise ValueError(f"Unexpected map tile dimensions in {tile}")
                layer = source.convert("RGBA").crop(rect)
                heights = map_tiles.parent / "heights" / str(level) / filename
                layer, removed = unproject_lofts(layer, heights, rect, xs, zs, field, palette, blocks_per_pixel)
                projected_pixels += removed
                # Tile pixels are ordered west to east and north to south in world coordinates.
                colors.paste(layer.convert("RGB"), (ox + left, oz + top), layer)
    return projected_pixels


def build(vista, map_tiles, out):
    manifest = json.loads((vista / "manifest.json").read_text(encoding="utf-8"))
    if manifest["version"] != 2:
        raise ValueError("Vista version 2 is required")
    min_x, min_z, max_x, max_z = manifest["bounds"]
    west = math.floor(min_x / 4) * 64
    north = math.floor(min_z / 4) * 64
    east = math.ceil((max_x + 1) / 4) * 64
    south = math.ceil((max_z + 1) / 4) * 64
    field = np.zeros(((south - north) // VISTA_STEP, (east - west) // VISTA_STEP), dtype=SURFACE)
    for x, z in manifest["regions"]:
        raw = (vista / f"{x}.{z}.bin").read_bytes()
        cells = np.ndarray((66, 66), dtype=SURFACE, buffer=raw, offset=8)
        tx, tz = x * 64 - west // VISTA_STEP, z * 64 - north // VISTA_STEP
        x0, z0 = max(0, tx), max(0, tz)
        x1, z1 = min(field.shape[1], tx + 64), min(field.shape[0], tz + 64)
        if x0 < x1 and z0 < z1:
            field[z0:z1, x0:x1] = cells[1+z0-tz:1+z1-tz, 1+x0-tx:1+x1-tx]

    samples_per_step = RELIEF_STEP // VISTA_STEP
    radius = samples_per_step // 2
    rows, cols = field.shape[0] // samples_per_step + 1, field.shape[1] // samples_per_step + 1
    heights = np.zeros((rows, cols, 4), dtype=np.uint8)
    floor = field["height"]
    for z in range(rows):
        for x in range(cols):
            sx, sz = x * samples_per_step, z * samples_per_step
            values = floor[max(0, sz-radius):sz+radius, max(0, sx-radius):sx+radius]
            values = values[values > 0]
            if values.size:
                # Vista records the top surface in eighth-block units, not the height of the block below it.
                height = round(np.median(values))
                heights[z, x] = (height >> 8, height & 255, 0, 255)

    palette = ground_palette(vista.parent / "textures" / "atlas.png")
    colors = Image.new("RGB", ((east - west) // COLOR_STEP, (south - north) // COLOR_STEP), "#687c7b")
    removed = paint_tiles(colors, map_tiles, (west, north, east, south), COLOR_STEP, field, (west, north), palette)
    out.mkdir(parents=True, exist_ok=True)
    Image.fromarray(heights).save(out / "altitude-heights.png", optimize=True)
    colors.save(out / "altitude-colors.webp", quality=90, method=4)
    descriptor = {"vistaHash": manifest["hash"], "west": west, "north": north, "east": east,
                  "south": south, "step": RELIEF_STEP, "columns": cols, "rows": rows, "heightScale": 8}

    dw, dn, de, ds = DETAIL_BOUNDS
    dw, dn, de, ds = max(dw, west), max(dn, north), min(de, east), min(ds, south)
    if dw < de and dn < ds:
        fallback = ((dw - west) // COLOR_STEP, (dn - north) // COLOR_STEP,
                    (de - west) // COLOR_STEP, (ds - north) // COLOR_STEP)
        detail = colors.crop(fallback).resize(((de - dw) // DETAIL_STEP, (ds - dn) // DETAIL_STEP))
        removed += paint_tiles(detail, map_tiles, (dw, dn, de, ds), DETAIL_STEP, field, (west, north), palette)
        detail.save(out / "altitude-detail.webp", quality=92, method=4)
        descriptor["detail"] = {"west": dw, "north": dn, "east": de, "south": ds}

    (out / "altitude-map-data.mjs").write_text("export default " + json.dumps(descriptor) + ";\n",
                                               encoding="utf-8")
    print(json.dumps(descriptor))
    print(f"Restored terrain under {removed} projected loft pixels")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vista", type=Path, required=True)
    parser.add_argument("--tiles", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    build(args.vista, args.tiles, args.out)
