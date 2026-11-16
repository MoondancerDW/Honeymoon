import argparse
from pathlib import Path
from zipfile import ZipFile
import shutil

parser = argparse.ArgumentParser(description="Import the original bard recordings for the native NPCs.")
parser.add_argument("mod", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)

songs = (
    "EveningCherryTHEME.ogg",
    "HalflingPonyTHEME.ogg",
    "LakeOfFearTHEME.ogg",
    "LetItSnowTHEME.ogg",
    "MarineDewTHEME.ogg",
    "TheKyleb - Bard.ogg",
)
with ZipFile(args.mod) as archive:
    names = {entry.rsplit("/", 1)[-1]: entry for entry in archive.namelist() if entry.startswith("resources/")}
    for song in songs:
        if song not in names:
            print(f"Missing from this mod archive: {song}")
            continue
        with archive.open(names[song]) as source:
            header = source.read(4)
            if header != b"OggS":
                raise ValueError(f"Mismatched audio format: {song}")
            with (args.output / song).open("wb") as destination:
                destination.write(header)
                shutil.copyfileobj(source, destination)
        print(song)
