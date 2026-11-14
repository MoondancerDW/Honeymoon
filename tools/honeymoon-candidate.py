from bundle_paths import report_path
import gzip
import json
import struct
import zlib
from collections import Counter
from pathlib import Path

from honeymoon_inventory import Nbt, ROOT, chunk_locations, read_level, region_files


def main():
    data = read_level()["Data"]
    sx, sz = data["SpawnX"] // 16, data["SpawnZ"] // 16
    areas = {
        "centered_192": (-6, 5, -6, 5),
        "centered_128": (-4, 3, -4, 3),
    }
    counts = {name: Counter() for name in areas}
    for path in region_files(ROOT / "region"):
        locs = [(x, z, off) for x, z, off in chunk_locations(path)
                if abs(x - sx) <= 16 and abs(z - sz) <= 16]
        if not locs:
            continue
        contents = path.read_bytes()
        for x, z, off in locs:
            selected = [name for name, (x0, x1, z0, z1) in areas.items()
                        if x0 <= x <= x1 and z0 <= z <= z1]
            if not selected:
                continue
            offset = off * 4096
            size, kind = struct.unpack_from(">IB", contents, offset)
            raw = {1: gzip.decompress, 2: zlib.decompress, 3: bytes}[
                kind](contents[offset + 5:offset + 4 + size])
            level = Nbt(raw).read({"Level": {"TileEntities": {"id": True}}})["Level"]
            types = Counter(tile["id"] for tile in level.get("TileEntities", []))
            for name in selected:
                counts[name].update(types)
                counts[name]["chunks"] += 1
    report = {name: {"chunks": counter["chunks"], "covers": counter["Covers"],
                     "signs": counter["Sign"], "bookcases": counter["BookcaseTile"],
                     "seats": sum(n for key, n in counter.items()
                                  if any(k in key for k in ("Sofa", "Chair")))}
              for name, counter in counts.items()}
    report_path("honeymoon-candidate.json").write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
