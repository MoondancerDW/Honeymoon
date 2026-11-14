"""Build the private Windows test bundle from a prepared Honeymoon world."""

import argparse
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


PROJECT = Path(__file__).resolve().parents[1]


def add_tree(archive, directory, relative_to, include=lambda _path: True):
    for path in sorted(directory.rglob("*")):
        if path.is_file() and include(path):
            archive.write(path, f"{relative_to}/{path.relative_to(directory).as_posix()}")


def build(output, node, node_license, generated):
    for asset in ("world/world.json", "textures/atlas.png", "models/redpower.json", "sounds/sounds.json"):
        if not (generated / asset).is_file():
            raise FileNotFoundError(generated / asset)

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(".zip.part")
    try:
        with ZipFile(temporary, "w", compression=ZIP_DEFLATED, compresslevel=6) as archive:
            for name in ("Start-Honeymoon.cmd", "Launch-Honeymoon.mjs", "ЧИТАЙ-МЕНЯ.txt"):
                archive.write(PROJECT / "portable" / name, name)
            for name in ("package.json", "README.md"):
                archive.write(PROJECT / name, name)
            for source in ("client", "server", "world"):
                add_tree(archive, PROJECT / source, source, lambda path: path.suffix in {".mjs", ".html", ".css", ".json"}
                         and not path.name.endswith(".test.mjs"))
            for family in ("world", "textures", "models", "sounds"):
                add_tree(archive, generated / family, f"generated/{family}")
            three = PROJECT / "node_modules" / "three"
            for name in ("package.json", "LICENSE", "build/three.module.js", "build/three.core.js"):
                archive.write(three / name, (Path("node_modules/three") / name).as_posix())
            archive.write(node, "runtime/node.exe")
            archive.write(node_license, "runtime/LICENSE.txt")
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
    args = parser.parse_args()
    build(args.output, args.node, args.node_license, args.generated)
