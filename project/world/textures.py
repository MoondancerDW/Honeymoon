"""Extract the prototype atlas from the original client. Output stays under generated/."""
import argparse
from contextlib import ExitStack
from io import BytesIO
import json
from pathlib import Path
from zipfile import BadZipFile, ZipFile

from PIL import Image, ImageDraw


HERE = Path(__file__).resolve().parent
DEFAULT_SOURCE = HERE.parents[1] / "sources" / "Honeymoon"
DEFAULT_OUTPUT = HERE.parent / "generated" / "textures"
GRID = 64
TILE = 16
CONNECTED_TEXTURE_START = 3328
CHISEL_CTM_START = 3584
CHEST_START = 3660
OPEN_CHEST_START = 3744
JAMMY_CUBE_START = 3880
CREATIVE_RECIPES = HERE / "creative-textures.json"
CARPENTRY_MODEL_WIDTH, CARPENTRY_MODEL_HEIGHT = 128, 64

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
    "redpower-core": "mods/RedPowerCore-2.0pr6.zip",
    "digital": "mods/RedPowerDigital-2.0pr6.zip",
    "redpower-compat": "mods/RedPowerCompat-2.0pr6.zip",
    "cloud": "mods/MLB-CORE_147.zip",
    "clouds": "mods/MLB-CLOUDS_147.zip",
    "vegetation": "mods/MLB-VEG_147.zip",
    "campfire": "mods/CampfireMod_2.4_for_1.4.7.zip",
    "pam": "mods/Pam's HarvestCraft.zip",
    "chisel": "mods/ChiselRetro_beta0.9_mc1.4.7.zip",
    "mocreatures": "mods/DrZharks MoCreatures Mod v4.7.0.zip",
    "twilight": "mods/twilightforest-1.15.4.jar",
    "jammy": "mods/1.4.7_Jammy_Furniture_Mod_V4.1.zip",
    "biblio": "mods/BiblioCraft.zip",
    "customnpcs": "mods/CustomNPCs_1.4.7.zip",
}


class TextureAtlas:
    def __init__(self, source, stack, vanilla_jar=None, rows=GRID):
        self.archive_paths = {name: source / path for name, path in ARCHIVES.items()}
        self.archive_labels = ARCHIVES.copy()
        if vanilla_jar is not None:
            self.archive_paths["vanilla"] = vanilla_jar
            self.archive_labels["vanilla"] = vanilla_jar.name
        self.stack = stack
        self.archives = {}
        self.rows = rows
        self.image = Image.new("RGBA", (GRID * TILE, rows * TILE))
        self.resources = {}

    def open_archive(self, name):
        if name not in self.archives:
            path = self.archive_paths[name]
            try:
                self.archives[name] = self.stack.enter_context(ZipFile(path))
            except FileNotFoundError:
                self.archives[name] = None
            except BadZipFile as error:
                raise ValueError(f"Invalid ZIP or JAR archive: {path}") from error
        return self.archives[name]

    def resolve(self, resource, dependency, override_aliases=(), required=True, *, vanilla_first=False):
        # Pack exact path takes precedence. Aliases account for the older model paths
        # in this particular pack. Fall back to the mod, then the base archive.
        ordered = [("pack", candidate) for candidate in (resource, *override_aliases)]
        if vanilla_first:
            ordered.append(("vanilla", resource))
        if dependency not in {"vanilla", "pack"}:
            ordered.append((dependency, resource))
        if not vanilla_first:
            ordered.append(("vanilla", resource))
        attempted = []
        for archive, candidate in ordered:
            source = self.open_archive(archive)
            path = self.archive_paths[archive]
            if source is None:
                message = f"{path} (missing archive)"
                if message not in attempted:
                    attempted.append(message)
                continue
            try:
                contents = source.read(candidate)
            except KeyError:
                attempted.append(f"{path} (missing {candidate})")
                continue
            self.resources[resource] = {
                "archive": self.archive_labels[archive], "resource": candidate,
            }
            with Image.open(BytesIO(contents)) as image:
                return image.convert("RGBA")
        if not required:
            return None
        searched = "\n  ".join(attempted)
        hint = ""
        if self.archives["vanilla"] is None:
            hint = "\nFor base-game textures, use --vanilla-jar with an installed Minecraft Java 1.4.7 JAR."
        raise FileNotFoundError(f"Texture {resource!r} could not be found. Searched:\n  {searched}{hint}")

    def paste(self, index, image):
        if not 0 <= index < GRID * self.rows:
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

    def legacy_crop(self, index, image, rect, size):
        """Crop a source model rectangle at the resource pack's actual resolution."""
        self.paste(index, legacy_patch(image, rect, size))

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


def legacy_patch(image, rect, size):
    left, top, right, bottom = rect
    w, h = size
    bounds = (left * image.width // w, top * image.height // h,
              right * image.width // w, bottom * image.height // h)
    if not (0 <= bounds[0] < bounds[2] <= image.width and 0 <= bounds[1] < bounds[3] <= image.height):
        raise ValueError(f"Invalid source rectangle {rect} for {image.size} at logical size {size}")
    return image.crop(bounds)


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


def add_kitchen_cupboards(atlas):
    for variant, name in enumerate(("kitchencupboardnotop", "kitchencupboard")):
        source = atlas.jammy(name)
        for part, dimensions in enumerate(((0, 0, 16, 16, 16), (0, 0, 1, 3, 1))):
            for side, rect in enumerate(model_faces(*dimensions)):
                patch = get_patch(source, rect).transpose(Image.Transpose.FLIP_TOP_BOTTOM)
                atlas.paste(3210 + variant * 12 + part * 6 + side, patch)


def add_jammy_cubes(atlas):
    # Full exterior ModelBoxes from the original models, in geometry.mjs order.
    cubes = (
        ("kitchencupboardnotop", 0, (64, 32), 4),
        ("kitchencupboard", 0, (64, 32), 4),
        ("cooker", 31, (128, 128), 4),
        ("washingmachine", 25, (64, 64), 4),
        ("roofing", 0, (128, 64), 1),
    )
    cap_turns = (Image.Transpose.ROTATE_180, Image.Transpose.ROTATE_90, None, Image.Transpose.ROTATE_270)
    for variant, (name, offset_y, size, headings) in enumerate(cubes):
        path = f"jammy780/furniture/textures/jammy_{name}.png"
        source = atlas.resolve(path, "jammy", vanilla_first=True)
        first_tile = JAMMY_CUBE_START + variant * 12
        faces = model_faces(0, offset_y, 16, 16, 16)
        faces[2], faces[3] = faces[3], faces[2]
        for face, rect in enumerate(faces):
            patch = legacy_patch(source, rect, size)
            if face not in (2, 3):
                atlas.paste(first_tile + face, patch)
                continue
            for heading in range(headings):
                rotation = cap_turns[heading]
                index = first_tile + (face if heading == 0 else 4 + heading * 2 + face - 2)
                atlas.paste(index, patch.transpose(rotation) if rotation is not None else patch)


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


def add_fruit_crops(atlas, start, names):
    for offset, crop in enumerate(names):
        texture = atlas.resolve(f"pam/harvestcraft/pamhc{crop}.png", "pam")
        width, height = texture.width // 16, texture.height // 16
        for stage in range(3):
            rect = (stage * width, 0, (stage + 1) * width, height)
            atlas.paste(start + offset * 3 + stage, texture.crop(rect))


def add_harvestcraft_tiles(atlas):
    storage = ("turnip", "garlic", "celery", "asparagus", "tea", "spiceleaf", "banana", "peach",
               "lettuce", "onion", "apple", "cucumber", "rice")
    wild = ("whitemushroom", "blackberry", "raspberry", "cranberry", "spiceleaf", "strawberry", "cotton", "blueberry")
    ranges = [(3604 + offset, name, 48, 1) for offset, name in enumerate(storage)]
    ranges.append((3617, "vanillastorage", 0, 16))
    ranges += [(3633 + offset, name, 2, 1) for offset, name in enumerate(wild)]
    ranges += [(3641 + row * 4, "sink", row * 16, 4) for row in range(3)]
    ranges.extend(((3732, "coffee", 48, 1), (3733, "mango", 48, 1), (3734, "kiwi", 2, 1)))
    ranges.extend(((3792, "salt", 0, 1), (3793, "salt", 48, 1)))
    ranges.extend((3861 + offset, name, 48, 1) for offset, name in enumerate(
        ("corn", "peanut", "olive", "bellpepper", "cherry", "orange", "cinnamon")))
    ranges.extend((3868 + offset, name, 2, 1) for offset, name in enumerate(("cactusfruit", "candle", "grape")))
    ranges.extend((3871 + offset, name, 16, 1) for offset, name in enumerate(("avocado", "peach")))
    images = {}
    for start, name, first, count in ranges:
        if name not in images:
            images[name] = atlas.resolve(f"pam/harvestcraft/pamhc{name}.png", "pam")
        image = images[name]
        w, h = image.width // 16, image.height // 16
        for offset in range(count):
            x, y = (first + offset) % 16 * w, (first + offset) // 16 * h
            atlas.paste(start + offset, image.crop((x, y, x + w, y + h)))


def add_chisel(atlas, fallback):
    paths = ("planks-birch/blinds", "fft/block", "gold/terrain-gold-space-side",
             "gold/terrain-gold-space-top", "gold/terrain-gold-space-bottom")
    fantasy = None
    for offset, path in enumerate(paths):
        tile = atlas.resolve(f"assets/chisel/textures/blocks/{path}.png", "chisel", required=False)
        atlas.paste(3298 + offset, fallback if tile is None else tile)
        if path == "fft/block":
            fantasy = tile
    if fantasy is None:
        return False
    seams = atlas.resolve("assets/chisel/textures/blocks/fft/block-ctm.png", "chisel", required=False)
    settings = atlas.archive_paths["chisel"].parents[1] / "config" / "Chisel.cfg"
    disabled = settings.is_file() and any(line.strip().lower() == 'b:"disable connected textures"=true'
                                           for line in settings.read_text(encoding="utf-8", errors="replace").splitlines())
    if seams is None or disabled:
        return False
    for offset, image, size in ((0, seams, 4), (16, fantasy, 2)):
        if image.width % size or image.height % size:
            raise ValueError(f"Invalid Chisel CTMX grid {image.size}")
        w, h = image.width // size, image.height // size
        for y in range(size):
            for x in range(size):
                atlas.paste(CHISEL_CTM_START + offset + y * size + x, image.crop((x * w, y * h, (x + 1) * w, (y + 1) * h)))
    return True


def add_mocreatures_tiles(atlas, fallback):
    texture = atlas.resolve("mods/mocreatures/textures/misc/blocks.png", "mocreatures", required=False)
    # The rock class's textureINT defaults to zero; the log constructor receives base 16.
    for offset, index in enumerate((1, 18, 19)):
        if texture is None:
            atlas.paste(3653 + offset, fallback)
            continue
        w, h = texture.width // 16, texture.height // 16
        x, y = index % 16 * w, index // 16 * h
        atlas.paste(3653 + offset, texture.crop((x, y, x + w, y + h)))


def add_standing_sign(atlas):
    image = atlas.resolve("item/sign.png", "vanilla")
    for first, y, width, height in ((3303, 0, 24, 12), (3309, 14, 2, 14)):
        depth = 2
        # The sign model flips its Y/Z axes, exchanging top/bottom and front/back.
        top = (depth, y, depth + width, y + depth)
        bottom = (depth + width, y, depth + 2 * width, y + depth)
        side_y = y + depth
        left = (0, side_y, depth, side_y + height)
        right = (depth + width, side_y, 2 * depth + width, side_y + height)
        front = (depth, side_y, depth + width, side_y + height)
        back = (2 * depth + width, side_y, 2 * depth + 2 * width, side_y + height)
        for face, rect in enumerate((left, right, top, bottom, back, front)):
            tile = legacy_patch(image, rect, (64, 32))
            atlas.paste(first + face, tile.transpose(Image.Transpose.FLIP_TOP_BOTTOM) if face not in (2, 3) else tile)


def add_chests(atlas):
    # ModelChest (awq) and ModelLargeChest (awx). The renderer flips Y and Z.
    # Split the large model in texture space so each half fits in one voxel.
    sources = (("chest", 14, None), ("enderchest", 14, None),
               ("largechest", 30, 0), ("largechest", 30, 1))
    # A 90-degree hinge moves the front to the top, the top to the back, etc.
    # Align the image axes of each moved face to the mesh worker's UV axes.
    open_faces = ((0, Image.Transpose.ROTATE_90), (1, Image.Transpose.ROTATE_270),
                  (5, Image.Transpose.FLIP_TOP_BOTTOM), (4, Image.Transpose.ROTATE_180),
                  (2, Image.Transpose.FLIP_LEFT_RIGHT), (3, None))
    images = {}
    for variant, (name, width, half) in enumerate(sources):
        if name not in images:
            images[name] = atlas.resolve(f"item/{name}.png", "vanilla")
        size = (128 if half is not None else 64, 64)
        for part, (y, w, h, d) in enumerate(((19, width, 10, 14), (0, width, 5, 14), (0, 2, 4, 1))):
            rectangles = model_faces(0, y, w, h, d)
            for face, source_face in enumerate((1, 0, 3, 2, 5, 4)):
                left, top, right, bottom = rectangles[source_face]
                if half is not None:
                    if face == 1 - half:
                        continue
                    if face >= 2:
                        middle = (left + right) // 2
                        if half ^ (face == 4):
                            left = middle
                        else:
                            right = middle
                # The source draws the base over the lid's lower pixel where
                # their side faces overlap with the lid closed.
                if part:
                    opened, transpose = open_faces[face]
                    tile = legacy_patch(images[name], (left, top, right, bottom), size)
                    if transpose is not None:
                        tile = tile.transpose(transpose)
                    atlas.paste(OPEN_CHEST_START + variant * 12 + (part - 1) * 6 + opened, tile)
                if part == 1 and face not in (2, 3):
                    bottom -= 1
                index = CHEST_START + variant * 18 + part * 6 + face
                atlas.legacy_crop(index, images[name], (left, top, right, bottom), size)


def add_campfire(atlas):
    image = atlas.resolve("CampfireMod/CampfireBlock.png", "campfire")
    # The ash skirt's UV extends one pixel past the old GL_REPEAT sheet.
    wrapped = Image.new("RGBA", (image.width, 2 * image.height))
    wrapped.paste(image, (0, 0))
    wrapped.paste(image, (0, image.height))
    # ModelCampfire uses three ModelBox textures for the sticks, ash, and stones.
    for part, dims in enumerate(((0, 0, 1, 16, 1), (0, 20, 12, 1, 12), (16, 0, 2, 4, 14))):
        for face, rect in enumerate(model_faces(*dims)):
            atlas.legacy_crop(3798 + part * 6 + face, wrapped, rect, (64, 64))


def add_creative_tiles(atlas, recipes):
    # The original texture pack overrides resources in every legacy mod archive.
    # Build the lookup once and keep at most one decoded image per referenced resource.
    images = {}
    archive_for = {}
    for family in ("pack", *(family for family in ARCHIVES if family != "pack")):
        source = atlas.open_archive(family)
        if source is not None:
            for resource in source.namelist():
                if resource.endswith(".png"):
                    archive_for.setdefault(resource, family)
    missing = []
    for index, (resource, x, y, cols, rows) in enumerate(recipes["sources"], recipes["firstTile"]):
        if resource not in images:
            images[resource] = atlas.resolve(resource, archive_for[resource], required=False) if resource in archive_for else None
        image = images[resource]
        if image is None or not 0 <= x < cols or not 0 <= y < rows or image.width % cols or image.height % rows:
            missing.append({"tile":index, "resource":resource, "cell":[x, y], "grid":[cols, rows]})
            atlas.paste(index, atlas.image.crop((3203 % GRID * TILE, 3203 // GRID * TILE,
                (3203 % GRID + 1) * TILE, (3203 // GRID + 1) * TILE)))
            continue
        w, h = image.width // cols, image.height // rows
        atlas.paste(index, image.crop((x * w, y * h, (x + 1) * w, (y + 1) * h)))
    return missing


def add_carpentry_bench(atlas, tile):
    texture = atlas.resolve("item/customnpcs/CarpentryBench.png", "customnpcs", required=False)
    if texture is None:
        return False
    texture = texture.resize((CARPENTRY_MODEL_WIDTH, CARPENTRY_MODEL_HEIGHT), Image.Resampling.NEAREST)
    atlas.image.paste(texture, (tile % GRID * TILE, tile // GRID * TILE))
    return True


def build(source, output, vanilla_jar=None):
    recipes = json.loads(CREATIVE_RECIPES.read_text(encoding="utf-8"))
    if recipes["schemaVersion"] != 1 or recipes["firstTile"] != GRID * GRID:
        raise ValueError("Unsupported creative texture recipe")
    atlas_rows = recipes["carpentryTile"] // GRID + CARPENTRY_MODEL_HEIGHT // TILE
    with ExitStack() as resources:
        atlas = TextureAtlas(source, resources, vanilla_jar, rows=atlas_rows)
        for index, resource, dependency in ATLAS_SOURCES:
            atlas.grid(index, atlas.resolve(resource, dependency))
        alloy_furnace = atlas.resolve("eloraam/base/base1.png", "redpower-core")
        for offset in range(4):
            atlas.legacy_crop(3794 + offset, alloy_furnace, (offset, 1, offset + 1, 2), (16, 16))
        add_campfire(atlas)
        add_fruit_crops(atlas, 3264, ("cinnamon", "vanillabean"))
        add_fruit_crops(atlas, 3286, ("apple", "olive", "lime", "lemon"))
        add_fruit_crops(atlas, 3735, ("papaya", "pomergranate"))
        add_fruit_crops(atlas, 3840, ("cherry", "plum", "walnut", "banana", "starfruit", "mango", "coconut"))
        add_harvestcraft_tiles(atlas)
        twilight = atlas.resolve("twilightforest/terrain.png", "twilight")
        for offset, tile in enumerate((7, 8, 9)):
            atlas.legacy_crop(3741 + offset, twilight, (tile, 0, tile + 1, 1), (16, 16))
        candles = atlas.resolve("pam/harvestcraft/pamhccandle.png", "pam")
        cw, ch = candles.width // 16, candles.height // 16
        for color in range(16):
            atlas.paste(3270 + color, candles.crop((color * cw, 4 * ch, (color + 1) * cw, 5 * ch)))
        terrain = atlas.resolve("terrain.png", "vanilla")
        connected = atlas.resolve("ctm.png", "vanilla", required=False)
        connected_textures = connected is not None and connected.size == terrain.size
        if connected_textures:
            atlas.grid(CONNECTED_TEXTURE_START, connected)
        add_armchairs(atlas)
        add_kitchen_cupboards(atlas)
        add_bookcases(atlas)
        add_furniture(atlas)
        add_jammy_cubes(atlas)
        # The original OptiFine profile uses the pack terrain tiles instead of
        # generated water. Its still tile 205 and flow tile 206 are identical.
        # misc/water.png is the first-person overlay used underwater.
        atlas.legacy_crop(3200, terrain, (13, 12, 14, 13), (16, 16))
        # Old Minecraft animates liquids procedurally. Keep the stored lava
        # source tile as the static frame, if the pack provides one.
        atlas.legacy_crop(3201, terrain, (13, 14, 14, 15), (16, 16))
        add_chests(atlas)
        fallback = Image.new("RGBA", (TILE, TILE), (120, 96, 130, 255))
        draw = ImageDraw.Draw(fallback)
        draw.rectangle((0, 0, 7, 7), fill=(171, 145, 179, 255))
        draw.rectangle((8, 8, 15, 15), fill=(171, 145, 179, 255))
        atlas.paste(3203, fallback)
        chisel_connected_textures = add_chisel(atlas, fallback)
        add_mocreatures_tiles(atlas, fallback)
        atlas.paste(3204, Image.new("RGBA", (TILE, TILE), (255, 255, 255, 255)))
        atlas.legacy_crop(3205, terrain, (4, 0, 5, 1), (16, 16))
        add_standing_sign(atlas)
        missing = add_creative_tiles(atlas, recipes)
        carpentry_model = add_carpentry_bench(atlas, recipes["carpentryTile"])
        if missing:
            print(f"Creative texture resources missing: {len(missing)}. See atlas.json.")
        output.mkdir(parents=True, exist_ok=True)
        atlas.image.save(output / "atlas.png", optimize=True)
        atlas.resolve("art/kz.png", "vanilla").save(output / "paintings.png", optimize=True)
        (output / "atlas.json").write_text(json.dumps({
            "schemaVersion": 11, "grid": GRID, "rows": atlas_rows, "tileSize": TILE, "resources": atlas.resources,
            "creativeMissingTiles":missing, "carpentryModel":carpentry_model,
            "connectedTextures": connected_textures, "chiselConnectedTextures": chisel_connected_textures,
        }, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        return len(atlas.resources)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--vanilla-jar", type=Path, help="Use an installed Minecraft Java 1.4.7 JAR as a fallback")
    args = parser.parse_args()
    try:
        count = build(args.source, args.output, args.vanilla_jar)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Texture extraction failed: {error}\n")
    print(f"Extracted {count} resources to {args.output}")
