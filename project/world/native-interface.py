"""Import the inventory UI and wearable armor textures from the original client."""

import argparse
from contextlib import ExitStack
from pathlib import Path

from PIL import Image, ImageChops

from textures import DEFAULT_OUTPUT, DEFAULT_SOURCE, TextureAtlas


ARMOR = [
    ("cloth", "vanilla"), ("chain", "vanilla"), ("iron", "vanilla"),
    ("diamond", "vanilla"), ("gold", "vanilla"),
    ("croc", "mocreatures"), ("fur", "mocreatures"), ("hide", "mocreatures"),
    ("scorpd", "mocreatures"), ("scorpf", "mocreatures"),
    ("scorpc", "mocreatures"), ("scorpn", "mocreatures"),
    ("hardenedleatherArmor", "pam"), ("naga_scale", "twilight"),
    ("ironwood", "twilight"), ("fiery", "twilight"), ("steeleaf", "twilight"),
]


def build_interface(assets):
    screen = Image.new("RGBA", (512, 352))
    for name, position in {
        "list_items": (0, 0), "search": (256, 0), "survival_inv": (0, 140),
    }.items():
        image = assets.resolve(f"gui/creative_inv/{name}.png", "vanilla")
        screen.paste(image.crop((0, 0, 195, 136)), position)
    tabs = assets.resolve("gui/allitems.png", "vanilla")
    screen.paste(tabs.crop((0, 0, 256, 130)), (256, 140))
    hud = assets.resolve("gui/gui.png", "vanilla")
    screen.paste(hud.crop((0, 0, 182, 22)), (0, 280))
    screen.paste(hud.crop((0, 22, 24, 46)), (184, 280))
    items = assets.resolve("gui/items.png", "vanilla")
    for slot in range(4):
        screen.paste(items.crop((240, slot * 16, 256, (slot + 1) * 16)), (slot * 16, 320))
    return screen


def legacy_sheet(image):
    width, height = image.size
    if height == width:
        image = image.crop((0, 0, width, height // 2))
    return image.resize((64, 32), Image.Resampling.NEAREST)


def adapt_armor(source, template, layer):
    """Lay a mod's Biped textures onto the native pony armor UV regions."""
    source = legacy_sheet(source)
    result = Image.new("RGBA", template.size)

    def copy(src, dst):
        size = (dst[2] - dst[0], dst[3] - dst[1])
        result.paste(source.crop(src).resize(size, Image.Resampling.NEAREST), dst[:2])

    if layer == 1:
        # Native head and shoulder shells use the same base texels as Biped.
        copy((0, 0, 64, 32), (0, 0, 64, 32))
        # The equine saddle extends across the back and sides.
        copy((20, 16, 36, 20), (32, 8, 60, 16))
        copy((16, 20, 40, 32), (16, 16, 64, 32))
        copy((4, 24, 8, 32), (48, 16, 64, 32))
    else:
        copy((0, 0, 64, 32), (0, 0, 64, 32))
        copy((16, 20, 40, 32), (16, 8, 64, 32))
        copy((0, 16, 16, 32), (48, 8, 64, 32))

    # The native texture determines where the shell is open around the eyes,
    # mane, knees and belly. Fill those armor regions with the mod material.
    alpha = template.getchannel("A")
    fallback = source.crop((20, 22, 28, 32)).resize(result.size, Image.Resampling.NEAREST)
    if not fallback.getchannel("A").getbbox():
        bounds = source.getchannel("A").getbbox()
        if bounds:
            fallback = source.crop(bounds).resize(result.size, Image.Resampling.NEAREST)
    fallback.alpha_composite(result)
    fallback.putalpha(ImageChops.multiply(fallback.getchannel("A"), alpha))
    return fallback


def build_armor(assets):
    sheet = Image.new("RGBA", (128, 32 * len(ARMOR)))
    templates = [assets.resolve(f"armor/iron_{layer}_pony.png", "vanilla") for layer in (1, 2)]
    for row, (material, mod) in enumerate(ARMOR):
        for layer in (1, 2):
            if mod == "vanilla":
                image = legacy_sheet(assets.resolve(f"armor/{material}_{layer}_pony.png", mod))
                if material == "cloth":
                    tint = Image.new("RGB", image.size, (160, 101, 64))
                    alpha = image.getchannel("A")
                    image = ImageChops.multiply(image.convert("RGB"),tint).convert("RGBA")
                    image.putalpha(alpha)
                    overlay = assets.resolve(f"armor/cloth_{layer}_b_pony.png", mod)
                    image.alpha_composite(legacy_sheet(overlay))
            else:
                family = {"mocreatures": "mods/mocreatures/textures/armor",
                          "twilight": "twilightforest", "pam": "armor"}[mod]
                source = assets.resolve(f"{family}/{material}_{layer}.png", mod)
                image = adapt_armor(source, legacy_sheet(templates[layer - 1]), layer)
            sheet.paste(image, ((layer - 1) * 64, row * 32))
    return sheet


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    with ExitStack() as stack:
        assets = TextureAtlas(args.source, stack)
        build_interface(assets).save(args.output / "legacy-interface.png", optimize=True)
        build_armor(assets).save(args.output / "pony-armor.png", optimize=True)
