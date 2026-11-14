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
    with gzip.open(ROOT / "level.dat", "rb") as stream:
        registry = Nbt(stream.read()).read({"FML": {"ModItemData": True}})
    records = registry["FML"]["ModItemData"]
    positions = Counter()
    cover_shapes = Counter()
    cover_patterns = Counter()
    cover_part_counts = Counter()
    cover_payload_lengths = Counter()
    mod_chunks = set()
    for path in region_files(ROOT / "region"):
        locs = [(x, z, off) for x, z, off in chunk_locations(path)
                if abs(x - sx) <= 16 and abs(z - sz) <= 16]
        if not locs:
            continue
        contents = path.read_bytes()
        for x, z, off in locs:
            offset = off * 4096
            size, kind = struct.unpack_from(">IB", contents, offset)
            compressed = contents[offset + 5:offset + 4 + size]
            raw = {1: gzip.decompress, 2: zlib.decompress, 3: bytes}[kind](compressed)
            level = Nbt(raw).read({"Level": {"TileEntities": {
                "id": True, "y": True, "cvm": True, "cvs": True,
            }}})["Level"]
            for tile in level.get("TileEntities", []):
                if tile.get("id") == "Covers":
                    positions[tile.get("y")] += 1
                    mod_chunks.add((x, z))
                    cover_shapes[tile.get("cvm")] += 1
                    cover_patterns[(tile["cvm"], tile["cvs"])] += 1
                    cover_part_counts[tile["cvm"].bit_count()] += 1
                    cover_payload_lengths[len(tile.get("cvs", b""))] += 1
    report = {
        "distinct_cover_patterns": len(cover_patterns),
        "cover_part_counts": cover_part_counts.most_common(),
        "registry_sample": records[:2],
        "registry_selected": [
            record for record in records
            if isinstance(record, dict) and any(type(v) is int and v in (750, 3246, 4000, 2166, 2250)
                                                for v in record.values())
        ],
        "cover_positions_by_height": positions.most_common(12),
        "chunks_with_covers": len(mod_chunks),
        "cover_shape_counts": cover_shapes.most_common(10),
        "cover_payload_lengths": cover_payload_lengths.most_common(10),
    }
    report_path("honeymoon-cover-patterns.json").write_text(json.dumps(report, indent=2), encoding="utf-8")

if __name__ == "__main__":
    main()
