"""Connect the legacy block registry's texture faces to the Honeymoon atlas."""

import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import re


HERE = Path(__file__).resolve().parent
# Faces in source order [-Y,+Y,-Z,+Z,-X,+X] become our [-X,+X,-Y,+Y,-Z,+Z].
FACE_ORDER = (4, 5, 0, 1, 2, 3)
FIRST_ADDED_TILE = 4096
TERRAIN = "terrain.png"
CARPENTRY = "item/customnpcs/CarpentryBench.png"

# These sheets already occupy 256-tile ranges in the original web atlas.
BUILTIN_SHEETS = {
    TERRAIN: 0,
    "eloraam/world/world1.png": 256,
    "eloraam/machine/machine1.png": 512,
    "eloraam/lighting/lighting1.png": 768,
    "MLB/terrain.png": 1024,
    "pam/weeeflowers/pamweeeflowers.png": 1280,
    "pam/harvestcraft/pamhccotton.png": 1536,
    "eloraam/wiring/redpower1.png": 1792,
    "eloraam/control/control1.png": 2048,
    "eloraam/logic/logic1.png": 2304,
}

# Color-independent default materials for tile renderers that don't report a block sprite.
# The captured model continues to take precedence during world rendering.
MODEL_MATERIALS = {
    200:3079, 201:3211, 203:3082, 204:3089, 205:3088, 206:3088, 207:3092,
    208:3090, 209:3096, 210:3096, 211:3096, 212:3096,
    213:2561, 214:2561, 215:2561, 216:2561, 217:2561, 218:3097, 219:3073, 220:3072,
    750:1793, 751:512, 752:375, 753:2304, 756:800, 757:784, 758:800, 759:784,
    760:2064, 761:2064, 762:2064, 765:513, 768:784,
    2240:4, 2248:4, 2249:4, 2250:2817, 2251:3205, 2252:4, 2253:4, 2254:4, 2255:4,
    3000:3812, 3001:3812,
}

MODEL_CLASSES = ("net.minecraft.jammy780.", "jds.bibliocraft.")
FALLBACK_CHISEL = {79:67, 2824:67, 2834:103}


def read_rows(path):
    with path.open(encoding="utf-8-sig", newline="") as file:
        return {(int(row["id"]), int(row["meta"])): row for row in csv.DictReader(file, delimiter="\t")}


def source_icon(value):
    """Translate Chisel IconRegistry names and its indexed submap crops."""
    resource, sep, cell = value.partition("|")
    if resource.lower().startswith("chisel:"):
        resource = resource.split(":", 1)[1]
    if resource.startswith("assets/"):
        return [resource, 0, 0, 1, 1]
    if not re.fullmatch(r"[A-Za-z0-9_+./-]+", resource) or ".." in resource.split("/"):
        return None
    x, y = (int(i) for i in cell.split(".")) if sep else (0, 0)
    grid = (4 if resource.endswith(("-ctm1", "-ctm2", "-ctm3")) else 3 if resource.endswith("-v9") else 2) if sep else 1
    # BlockMarblePillar's inventory renderer asks getCtmIcon(0, metadata).
    # Its source atlas lookup can expose the whole vertical sheet for this icon.
    if not sep and resource.startswith("marblepillar/") and resource.endswith("-ctmv"):
        grid = 2
    return [f"assets/chisel/textures/blocks/{resource.removesuffix('.png')}.png", x, y, grid, grid]


def model_material(id_, meta):
    first = MODEL_MATERIALS.get(id_)
    if first is not None:
        if 213 <= id_ <= 217:
            return first + (meta // 4) * 64
        if 756 <= id_ <= 759 or id_ in {753, 768}:
            return first + meta
    return first


def compile_assets(registry_path):
    rows = read_rows(registry_path)
    sources = []
    indices = {}
    shape_data = []
    shape_indices = {}
    blocks = {}
    report = {"registered": 0, "capturedStates": 0, "creativeStates": 0, "undeterminedFaces": []}

    def store(recipe):
        key = tuple(recipe)
        if key not in indices:
            indices[key] = FIRST_ADDED_TILE + len(sources)
            sources.append(recipe)
        return indices[key]

    for (id_, meta), row in sorted(rows.items()):
        if row["class"] == "amq" and not row["blockName"]:
            continue
        path = row["textureFile"].lstrip("/")
        faces = [int(tile) for tile in row["faces"].split(",")]
        icons = row["icons"].split(",")
        cls = row["class"]
        if len(faces) != 6 or len(icons) != 6:
            raise ValueError(f"Incomplete source faces at {id_}:{meta}")
        tiles = []
        for face in FACE_ORDER:
            icon = icons[face]
            atlas = BUILTIN_SHEETS.get(path)
            if icon:
                source = source_icon(icon)
                tile = store(source) if source else 3203
            elif path.startswith("atlas_"):
                tile = FALLBACK_CHISEL.get(id_, 3203)
                if tile == 3203 and row["creative"] == "true":
                    report["undeterminedFaces"].append([id_, meta, face, faces[face], path])
            elif path == TERRAIN and faces[face] == 0 and model_material(id_, meta) is not None:
                tile = model_material(id_, meta)
            elif atlas is not None and 0 <= faces[face] < 256:
                tile = atlas + faces[face]
            elif path.endswith(".png") and 0 <= faces[face] < 256:
                x, y = faces[face] % 16, faces[face] // 16
                tile = store([path, x, y, 16, 16])
            else:
                tile = 3203
            tiles.append(tile)
        bounds = [float(value) for value in row["bounds"].split(",")]
        if len(bounds) != 6 or not all(math.isfinite(value) for value in bounds):
            raise ValueError(f"Invalid bounds for {id_}:{meta}")
        bounds = [round(bounds[i], 6) for i in (0, 2, 4, 1, 3, 5)]
        render = int(row["renderType"])
        flags = sum((row[trait] == "true") << bit for bit, trait in enumerate(
            ("opaque", "normal", "materialBlocks", "materialLiquid", "tileEntity")))
        if int(row["pass"]) == 1:
            flags |= 32
        tint = row.get("color", 16777215)
        tint = int(tint, 0) if isinstance(tint, str) and tint else 16777215
        kind = ""
        if cls.endswith("Slab"):
            kind = "slab"
        elif "Stairs" in cls:
            kind = "stairs"
        elif "Pane" in cls:
            kind = "pane"
        elif "Wall" in cls:
            kind = "wall"
        elif cls.endswith(("BlockTFPlant", "BlockTFMoonworm", "BlockTFCicada", "BlockTFFirefly")):
            kind = "sprite"
        elif cls.startswith(MODEL_CLASSES):
            kind = "model"
        shape = [tiles, render, bounds, flags, int(row["emission"]), tint, kind]
        signature = (tuple(tiles), render, tuple(bounds), *shape[3:])
        if signature not in shape_indices:
            shape_indices[signature] = len(shape_data)
            shape_data.append(shape)
        block = blocks.setdefault(id_, [])
        if meta != len(block):
            raise ValueError(f"Missing source state before {id_}:{meta}")
        block.append(shape_indices[signature])
        report["capturedStates"] += 1
        report["creativeStates"] += row["creative"] == "true"
    report.update({"registered": len(blocks), "addedTiles":len(sources), "distinctShapes":len(shape_data)})
    return blocks, shape_data, sources, report


def write_bench_model(path, output, tile):
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    quads = []
    for line in lines:
        texture, positions, uv = line.split("\t")
        if texture.lstrip("/") != CARPENTRY:
            raise ValueError(f"Unexpected carpentry texture {texture}")
        positions = [round(float(value), 8) for value in positions.split(",")]
        uv = [round(float(value), 8) for value in uv.split(",")]
        if len(positions) != 12 or len(uv) != 8:
            raise ValueError("Invalid carpentry bench ModelRenderer quad")
        quads.append([positions, uv])
    if len(quads) != 84:
        raise ValueError(f"Unexpected carpentry bench quad count: {len(quads)}")
    out = "// Generated by creative-assets.py from the original Custom NPCs carpentry TESR.\n"
    out += f"export const carpentryTile = {tile};\n"
    out += "export const carpentryQuads = [\n" + ''.join(f"  {json.dumps(quad, separators=(',', ':'))},\n" for quad in quads) + "];\n"
    (output / "carpentry-model-data.mjs").write_text(out, encoding="utf-8", newline="\n")


def write_outputs(registry, output, report_path, bench_model):
    blocks, shapes, sources, report = compile_assets(registry)
    output.mkdir(parents=True, exist_ok=True)
    dump = lambda value: json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    script = ["// Generated by creative-assets.py from the original Minecraft modpack block registry.",
              "// Each spec contains face tiles, renderer, bounds, flags, light emission, tint, and shape hint.",
              "const shapes = [", *(f"  {dump(shape)}," for shape in shapes), "];", "const blocks = {"]
    script.extend(f"  {id_}: {dump(indices)}," for id_, indices in blocks.items())
    script.extend(["};", "", "export function creativeBlock(id, meta) {",
                   "  const variants = blocks[id];", "  return variants && shapes[variants[meta]];", "}"])
    (output / "creative-blocks.mjs").write_text("\n".join(script) + "\n", encoding="utf-8", newline="\n")
    model_tile = math.ceil((FIRST_ADDED_TILE + len(sources)) / 64) * 64
    (output / "creative-textures.json").write_text(dump({"schemaVersion":1, "firstTile":FIRST_ADDED_TILE,
        "sources":sources, "carpentryTile":model_tile}) + "\n", encoding="utf-8", newline="\n")
    if bench_model:
        write_bench_model(bench_model, output, model_tile)
    report["sourceSha256"] = hashlib.sha256(registry.read_bytes()).hexdigest()
    if report_path:
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({key:value for key, value in report.items() if key != "undeterminedFaces"} |
                     {"undeterminedFaces":len(report["undeterminedFaces"])}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("registry", type=Path)
    parser.add_argument("--output", type=Path, default=HERE)
    parser.add_argument("--report", type=Path)
    parser.add_argument("--bench-model", type=Path)
    args = parser.parse_args()
    write_outputs(args.registry, args.output, args.report, args.bench_model)
