"""Copy the local Minecraft and Audiotori sounds into the browser asset catalog."""

import argparse
import csv
from hashlib import sha256
import json
from pathlib import Path, PurePosixPath
import re
from zipfile import ZipFile


HERE = Path(__file__).resolve().parent
SOURCE = HERE.parents[1] / "sources" / "Honeymoon"
OUTPUT = HERE.parent / "generated" / "sounds"
BLOCKS = HERE / "block-sound-types.json"
CHISEL = "mods/ChiselRetro_beta0.9_mc1.4.7.zip"
JAMMY = "mods/1.4.7_Jammy_Furniture_Mod_V4.1.zip"
BIBLIO = "mods/BiblioCraft.zip"
ALIASES = {
    "door.open": "random.door_open", "door.close": "random.door_close",
    "click": "random.click", "click.on": "random.click", "click.off": "random.click",
    "chest.open": "random.chestopen", "chest.close": "random.chestclosed",
    "piston.extend": "tile.piston.out", "piston.retract": "tile.piston.in",
    "step.anvil": "step.stone",
}


def settings(path):
    if not path.is_file():
        return {}
    return dict(line.strip().split("=", 1) for line in path.read_text(encoding="latin1").splitlines()
                if line.strip() and not line.startswith("#") and "=" in line)


def audio_files(folder):
    return sorted(path for path in folder.rglob("*") if path.is_file() and path.suffix.lower() == ".ogg")


def sound_id(relative):
    # The 1.4.7 sound pool groups numbered variants under a single key.
    path = relative.with_suffix("")
    stem = re.sub(r"\d+$", "", path.name) or path.name
    return ".".join((*path.parts[:-1], stem)).lower()


def probe_blocks(path):
    profiles = []
    blocks = {}
    instruments = {}
    materials = {"e": "bd", "p": "snare", "r": "hat", "d": "bassattack"}
    with path.open(encoding="utf-8-sig", newline="") as file:
        for item in csv.DictReader(file, delimiter="\t"):
            profile = [item["step"], item["place"], float(item["volume"]), float(item["pitch"])]
            if profile not in profiles:
                profiles.append(profile)
            blocks[item["id"]] = profiles.index(profile)
            instrument = materials.get(item["material"])
            if instrument:
                instruments.setdefault(instrument, []).append(int(item["id"]))
    with Path(str(path) + ".covers").open(encoding="utf-8") as file:
        covers = {key: int(value) for key, value in csv.reader(file, delimiter="\t")}
    return {"profiles": profiles, "blocks": blocks, "covers": covers, "instruments": instruments}


def extract(source, output, block_types):
    originals = source / "resources"
    original_samples = audio_files(originals / "sound3")
    if not original_samples:
        raise FileNotFoundError("Minecraft 1.4.7 sounds are required in resources/sound3")
    if output.is_relative_to(source) or source.is_relative_to(output):
        raise ValueError("Sound output must be separate from the source client")
    output.mkdir(parents=True, exist_ok=True)
    audiotori = source / "audiotori"
    config = settings(audiotori / "userconfig.cfg")
    folders = []
    if config.get("start.enabled") == "true":
        for name in config.get("packs.order", "").split(","):
            name = name.strip()
            if name and Path(name).name == name and name not in (".", ".."):
                pack = audiotori / name
                if pack.is_dir() and pack.resolve().is_relative_to(audiotori.resolve()):
                    folders.append(pack)

    sounds = {}
    provenance = {}

    def add(event, contents, origin, extension="ogg"):
        if extension == "wav":
            if not contents.startswith(b"RIFF") or contents[8:12] != b"WAVE":
                raise ValueError(f"Invalid WAV audio in {origin}")
        elif not contents.startswith(b"OggS"):
            raise ValueError(f"Invalid Ogg audio in {origin}")
        digest = sha256(contents).hexdigest()
        filename = f"{digest[:24]}.{extension}"
        file = output / filename
        if not file.exists() or file.read_bytes() != contents:
            file.write_bytes(contents)
        pool = sounds.setdefault(event, [])
        if filename not in pool:
            pool.append(filename)
        resource = provenance.setdefault(filename, {"sha256": digest, "sources": []})
        if origin not in resource["sources"]:
            resource["sources"].append(origin)

    # Audiotori substitutes each registered file by its path, preserving variants
    # with no replacement. Minecraft 1.4.7 registers sound3 for these effects.
    samples = {path.relative_to(originals / "sound3").as_posix().lower(): path for path in original_samples}
    discs = {path.stem.lower(): path for path in audio_files(originals / "streaming")}
    music = []
    for folder in reversed(folders):
        samples.update({path.relative_to(folder / "sound3").as_posix().lower(): path
                        for path in audio_files(folder / "sound3")})
        discs.update({path.stem.lower(): path for path in audio_files(folder / "streaming")})
        music.extend(audio_files(folder / "music"))
        music.extend(audio_files(folder / "newmusic"))
    if not music or config.get("stash.music") != "true":
        music.extend(audio_files(originals / "music"))
        music.extend(audio_files(originals / "newmusic"))
    for name, path in sorted(samples.items()):
        add(sound_id(PurePosixPath(name)), path.read_bytes(), path.relative_to(source).as_posix())
    for name, path in sorted(discs.items()):
        add("record." + name, path.read_bytes(), path.relative_to(source).as_posix())
    for path in music:
        add("music.overworld", path.read_bytes(), path.relative_to(source).as_posix())

    jammy = source / JAMMY
    if jammy.is_file():
        with ZipFile(jammy) as archive:
            for event in ("radio", "toilet"):
                name = f"jammy780/furniture/sounds/{event}.wav"
                add(f"jfm.{event}", archive.read(name), f"{JAMMY}!/{name}", "wav")
    biblio = source / BIBLIO
    if biblio.is_file():
        with ZipFile(biblio) as archive:
            for event in ("caseopen", "caseclose"):
                name = f"jds/bibliocraft/sound/{event}.ogg"
                add(f"jds.bibliocraft.sound.{event}", archive.read(name), f"{BIBLIO}!/{name}")
    chisel = source / CHISEL
    if chisel.is_file():
        with ZipFile(chisel) as archive:
            for name in sorted(archive.namelist()):
                path = PurePosixPath(name)
                if path.parts[:3] == ("assets", "chisel", "sound") and len(path.parts) == 4 and path.suffix == ".ogg":
                    add("chisel:" + sound_id(PurePosixPath(path.name)), archive.read(name), f"{CHISEL}!/{name}")
    for event, legacy in ALIASES.items():
        if legacy in sounds:
            sounds[event] = sounds[legacy]

    manifest = {"version": 3, **{key: block_types[key] for key in ("profiles", "blocks", "covers")},
                "sounds": sounds, "sources": provenance}
    # Preserve samples referenced by a previously-served catalog until its clients reload.
    temporary = output / "sounds.tmp"
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.replace(output / "sounds.json")
    print(f"{len(provenance)} sound files, {len(sounds)} events, {len(block_types['blocks'])} block sound profiles: {output}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--refresh-blocks", type=Path, help="Update block sound data from the 1.4.7 registry probe TSV")
    args = parser.parse_args()
    if args.refresh_blocks:
        profile = probe_blocks(args.refresh_blocks)
        BLOCKS.write_text(json.dumps(profile, separators=(",", ":")) + "\n", encoding="utf-8")
    else:
        profile = json.loads(BLOCKS.read_text(encoding="utf-8"))
    extract(args.source.resolve(), args.output.resolve(), profile)


if __name__ == "__main__":
    main()
