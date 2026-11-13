"""Extract the prototype atlas from the original client. Output stays under generated/."""
import argparse
from contextlib import ExitStack
from io import BytesIO
import json
from pathlib import Path
from zipfile import ZipFile

from PIL import Image, ImageDraw


HERE = Path(__file__).resolve().parent
DEFAULT_SOURCE = HERE.parents[1] / "sources" / "Honeymoon"
DEFAULT_OUTPUT = HERE.parent / "generated" / "textures"
GRID = 64
TILE = 16

# Keep the source atlas's own tile indices. The base IDs mirror geometry.mjs.
ATLAS_SOURCES = (
    (0, "terrain.png", "vanilla"),
    (256, "eloraam/world/world1.png", "mechanical"),
    (512, "eloraam/machine/machine1.png", "mechanical"),
    (768, "eloraam/lighting/lighting1.png", "digital"),
    (1024, "MLB/terrain.png", "cloud"),
    (1280, "pam/weeeflowers/pamweeeflowers.png", "pam"),
    (1536, "pam/harvestcraft/pamhccotton.png", "pam"),
    (1792, "eloraam/wiring/redpower1.png", "digital"),
    (2048, "eloraam/control/control1.png", "mechanical"),
    (2304, "eloraam/logic/logic1.png", "digital"),
)

ARCHIVES = {
    "pack": "texturepacks/My-Little-Ponyach-147f.zip",
    "vanilla": "minecraft.jar",
    "mechanical": "mods/RedPowerMechanical-2.0pr6.zip",
    "digital": "mods/RedPowerDigital-2.0pr6.zip",
    "cloud": "mods/MLB-CORE_147.zip",
    "pam": "mods/Pam's HarvestCraft.zip",
    "jammy": "mods/1.4.7_Jammy_Furniture_Mod_V4.1.zip",
    "biblio": "mods/BiblioCraft.zip",
}


class TextureAtlas:
    def __init__(self, archives):
        self.archives = archives
        self.image = Image.new("RGBA", (GRID * TILE, GRID * TILE))
        self.resources = {}

    def resolve(self, resource, dependency, override_aliases=()):
        # Pack exact path takes precedence. Aliases account for the older model paths
        # in this particular pack. Fall back to the mod, then the base archive.
        ordered = [("pack", candidate) for candidate in (resource, *override_aliases)]
        if dependency not in {"vanilla", "pack"}:
            ordered.append((dependency, resource))
        ordered.append(("vanilla", resource))
        for archive, candidate in ordered:
            try:
                contents = self.archives[archive].read(candidate)
            except KeyError:
                continue
            self.resources[resource] = {
                "archive": ARCHIVES[archive], "resource": candidate,
            }
            with Image.open(BytesIO(contents)) as image:
                return image.convert("RGBA")
        raise FileNotFoundError(resource)

    def paste(self, index, image):
        if not 0 <= index < GRID * GRID:
            raise ValueError(f"Tile {index} is outside the atlas")
        self.image.paste(
            image.resize((TILE, TILE), Image.Resampling.NEAREST),
            (index % GRID * TILE, index // GRID * TILE),
        )

    def grid(self, index, image):
        if image.width % 16 or image.height % 16:
            raise ValueError(f"Invalid legacy tile grid {image.size}")
        w, h = image.width // 16, image.height // 16
        for row in range(16):
            for col in range(16):
                self.paste(index + row * 16 + col, image.crop((col * w, row * h, (col + 1) * w, (row + 1) * h)))

    def jammy(self, name):
        name = f"jammy_{name}.png"
        return self.resolve(f"jammy780/furniture/textures/{name}", "jammy", (f"mods/jammy780/textures/{name}",))


def model_faces(offset_x, offset_y, width, height, depth):
    """Minecraft 1.4.7 ModelBox unfolded rectangles in [-X,+X,-Y,+Y,-Z,+Z] order."""
    a = offset_x
    b = a + depth
    c = b + width
    d = c + depth
    e = d + width
    v0 = offset_y
    v1 = v0 + depth
    v2 = v1 + height
    # Jammy's model rotates 180 degrees around Z before the heading transform.
    # Place the original -X / +X on the opposite world faces.
    return [(c, v1, d, v2), (a, v1, b, v2), (b, v0, c, v1),
            (c, v0, c + width, v1), (b, v1, c, v2), (d, v1, e, v2)]


def get_patch(image, area):
    patch = image.crop(area)
    if patch.getbbox():
        return patch
    opaque = image.getbbox()
    if opaque:
        sample_x = (opaque[0] + opaque[2]) // 2
        sample_y = (opaque[1] + opaque[3]) // 2
        sample = image.crop((sample_x - 2, sample_y - 2, sample_x + 2, sample_y + 2))
        if sample.getbbox():
            return sample
    return Image.new("RGBA", (TILE, TILE), (116, 93, 71, 255))


def add_armchairs(atlas):
    # ModelArmChair dimensions and per-piece UV origins in the source archive.
    geometry = [
        (0, 33, 16, 3, 16), (0, 13, 16, 14, 2), (38, 9, 2, 6, 14), (75, 12, 3, 3, 14),
        (38, 9, 2, 6, 14), (75, 12, 3, 3, 14), (0, 54, 2, 2, 2), (67, 35, 12, 3, 14),
    ]
    for color, name in enumerate(("red", "blue", "green", "grey")):
        source = atlas.jammy(f"armchair_{name}")
        for part, dims in enumerate(geometry):
            for side, rect in enumerate(model_faces(*dims)):
                patch = get_patch(source, rect).transpose(Image.Transpose.FLIP_TOP_BOTTOM)
                atlas.paste(2560 + color * 64 + part * 6 + side, patch)


def add_bookcases(atlas):
    for wood in range(4):
        source = atlas.resolve(f"jds/bibliocraft/textures/BookcaseTexture{wood + 1}.png", "biblio")
        for part, dims in enumerate(((0, 0, 30, 30, 1), (137, 0, 30, 1, 16))):
            for side, rect in enumerate(model_faces(*dims)):
                atlas.paste(2816 + wood * 16 + part * 6 + side, get_patch(source, rect))
        for offset in range(4):
            x = 12 + offset * 15
            atlas.paste(2816 + wood * 16 + 12 + offset, get_patch(source, (x, 72, x + 4, 85)))


def add_furniture(atlas):
    parts = [
        ("lightbulb", (5, 3, 13, 9)), ("lightbulb", (0, 11, 4, 15)),
        ("lamp", (18, 20, 26, 28)), ("lamp", (28, 20, 36, 29)),
        ("tablelamp", (0, 9, 8, 17)), ("tablelamp", (18, 9, 26, 17)),
        ("blinds", (0, 3, 16, 15)), ("clockbase", (8, 12, 16, 25)),
        ("clockmiddle", (5, 10, 15, 24)), ("clocktop", (5, 9, 16, 21)),
        ("chair", (3, 4, 11, 12)), ("kitchencupboardnotop", (7, 9, 19, 22)),
        ("kitchencupboard", (7, 9, 19, 22)), ("tv", (1, 11, 13, 22)),
        ("plantpot", (5, 9, 14, 18)), ("radio", (5, 6, 16, 14)),
        ("coffeetable", (5, 6, 16, 14)), ("cooker", (5, 10, 17, 23)),
        ("washingmachine", (5, 10, 17, 23)), ("fridge", (5, 10, 17, 23)),
        ("bathroomcupboard", (5, 10, 17, 23)), ("kitchensink", (5, 10, 17, 23)),
        ("rubbishbin", (5, 10, 17, 23)), ("plantpot", (5, 10, 17, 23)),
        ("pighead", (8, 8, 16, 16)), ("kitchenside", (5, 10, 17, 23)),
    ]
    for index, (name, rect) in enumerate(parts):
        patch = get_patch(atlas.jammy(name), rect)
        opaque = patch.getbbox()
        atlas.paste(3072 + index, patch.crop(opaque) if opaque else patch)


def build(source, output):
    with ExitStack() as resources:
        archives = {name: resources.enter_context(ZipFile(source / path)) for name, path in ARCHIVES.items()}
        atlas = TextureAtlas(archives)
        for index, resource, dependency in ATLAS_SOURCES:
            atlas.grid(index, atlas.resolve(resource, dependency))
        add_armchairs(atlas)
        add_bookcases(atlas)
        add_furniture(atlas)
        water = atlas.resolve("misc/water.png", "vanilla")
        if water.getchannel("A").getextrema() == (255, 255):
            water.putalpha(168)
        atlas.paste(3200, water)
        # Old Minecraft animates liquids procedurally. Keep the stored lava
        # source tile as the static frame, if the pack provides one.
        terrain = atlas.resolve("terrain.png", "vanilla")
        atlas.paste(3201, terrain.crop((13 * 16, 14 * 16, 14 * 16, 15 * 16)))
        chest = atlas.resolve("item/chest.png", "vanilla")
        for offset, rect in ((4, (0, 14, 14, 33)), (5, (14, 0, 28, 14)), (6, (14, 14, 28, 33))):
            atlas.paste(3202 + offset, chest.crop(rect))
        fallback = Image.new("RGBA", (TILE, TILE), (120, 96, 130, 255))
        draw = ImageDraw.Draw(fallback)
        draw.rectangle((0, 0, 7, 7), fill=(171, 145, 179, 255))
        draw.rectangle((8, 8, 15, 15), fill=(171, 145, 179, 255))
        atlas.paste(3203, fallback)
        atlas.paste(3204, Image.new("RGBA", (TILE, TILE), (255, 255, 255, 255)))
        atlas.paste(3205, terrain.crop((4 * 16, 0, 5 * 16, 16)))
        output.mkdir(parents=True, exist_ok=True)
        atlas.image.save(output / "atlas.png", optimize=True)
        atlas.resolve("art/kz.png", "vanilla").save(output / "paintings.png", optimize=True)
        (output / "atlas.json").write_text(json.dumps({
            "schemaVersion": 1, "grid": GRID, "tileSize": TILE, "resources": atlas.resources,
        }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return len(atlas.resources)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    print(f"Extracted {build(args.source, args.output)} resources to {args.output}")
