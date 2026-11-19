"""Build the private Windows test bundle from a prepared Lilium Moonlight world."""

import argparse
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZIP_STORED, ZipFile
from urllib.parse import urlsplit


PROJECT = Path(__file__).resolve().parents[1]


def add_tree(archive, directory, relative_to, include=lambda _path: True):
    for path in sorted(directory.rglob("*")):
        if path.is_file() and include(path):
            mode = ZIP_STORED if path.suffix.lower() in {'.gz', '.bin', '.png', '.ogg', '.webp'} else ZIP_DEFLATED
            archive.write(path, f"{relative_to}/{path.relative_to(directory).as_posix()}", compress_type=mode)


def build(output, node, node_license, generated, state=None, single_player=False, streaming_source=None):
    if streaming_source:
        origin = urlsplit(streaming_source)
        if origin.scheme != "https" or not origin.hostname or origin.username or origin.password \
                or origin.path not in ("", "/") or origin.query or origin.fragment:
            raise ValueError("Expected the HTTPS origin of the standalone download service")
        if state:
            raise ValueError("The downloadable standalone launcher cannot include a player's save")
        single_player = True
    else:
        for asset in ("world/world.json", "full-world/manifest.json", "vista/manifest.json", "weather/biomes.bin",
                      "textures/atlas.png", "models/redpower.json", "sounds/sounds.json", "npcs/original.json", "npcs/models.json"):
            if not (generated / asset).is_file():
                raise FileNotFoundError(generated / asset)

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".zip.part")
    try:
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=3) as archive:
            for name in ("Start-Lilium-Moonlight.cmd", "Start-Honeymoon.cmd", "single-instance.mjs"):
                archive.write(PROJECT / "portable" / name, name)
            help_file = "SINGLEPLAYER.txt" if single_player else "ЧИТАЙ-МЕНЯ.txt"
            archive.write(PROJECT / "portable" / help_file, "ЧИТАЙ-МЕНЯ.txt")
            launch = "Launch-Singleplayer.mjs" if single_player else "Launch-Honeymoon.mjs"
            archive.write(PROJECT / "portable" / launch, "Launch-Honeymoon.mjs")
            if single_player:
                archive.write(PROJECT / "portable" / "solo-cache.mjs", "solo-cache.mjs")
            if streaming_source:
                archive.writestr("solo-source.json", json.dumps({"origin": streaming_source.rstrip("/")}) + "\n")
            if not single_player:
                for name in ("Start-Server.cmd", "Start-Tailscale.cmd", "Start-Internet.cmd"):
                    archive.write(PROJECT / "portable" / name, name)
            for name in ("package.json", "README.md"):
                archive.write(PROJECT / name, name)
            for source in ("client", "server", "world"):
                add_tree(archive, PROJECT / source, source, lambda path: path.suffix in {".mjs", ".html", ".css", ".json", ".webmanifest", ".webp", ".png", ".svg", ".wav"}
                         and not path.name.endswith(".test.mjs"))
            if not streaming_source:
                for family in ("world", "full-world", "textures", "models", "sounds", "lod", "vista", "weather", "npcs"):
                    add_tree(archive, generated / family, f"generated/{family}")
                catalog = generated / "creative" / "catalog.json"
                if catalog.is_file():
                    archive.write(catalog, "generated/creative/catalog.json")
            three = PROJECT / "node_modules" / "three"
            for name in ("package.json", "LICENSE", "build/three.module.js", "build/three.core.js"):
                archive.write(three / name, (Path("node_modules/three") / name).as_posix())
            archive.write(node, "runtime/node.exe")
            archive.write(node_license, "runtime/LICENSE.txt")
            if state:
                archive.write(state, "state/honeymoon.sqlite")
        with ZipFile(temporary) as archive:
            bad_file = archive.testzip()
            if bad_file:
                raise ValueError(f"Corrupt ZIP member {bad_file}")
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("node", type=Path, help="Windows x64 Node.js 24 executable")
    parser.add_argument("node_license", type=Path, help="LICENSE from the matching Node.js release")
    parser.add_argument("--generated", type=Path, default=PROJECT / "generated")
    parser.add_argument("--state", type=Path, help="Optional SQLite snapshot prepared while the old server was running")
    parser.add_argument("--single-player", action="store_true", help="Start with a local-only profile")
    parser.add_argument("--streaming-source", help="Build the small solo launcher with progressive downloads from this HTTPS origin")
    args = parser.parse_args()
    build(args.output, args.node, args.node_license, args.generated, args.state, args.single_player, args.streaming_source)
