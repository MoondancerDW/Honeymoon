import gzip
import json
import re
import struct
import traceback
import zlib
from collections import Counter
from pathlib import Path

from bundle_paths import CLIENT_ROOT, report_path

ROOT = CLIENT_ROOT / "saves" / "equestria"
REPORT = report_path("honeymoon-inventory.json")
BLOCK_MASK = bytes([0] * 146 + list(range(146, 256)))


class Nbt:
    def __init__(self, raw):
        self.raw = raw
        self.pos = 0

    def take(self, size):
        value = self.raw[self.pos:self.pos + size]
        self.pos += size
        return value

    def number(self, fmt):
        result, = struct.unpack_from(">" + fmt, self.raw, self.pos)
        self.pos += struct.calcsize(fmt)
        return result

    def string(self):
        return self.take(self.number("H")).decode("utf-8", "replace")

    def payload(self, tag, selector):
        if tag in (1, 2, 3, 4, 5, 6):
            fmt = ("", "b", "h", "i", "q", "f", "d")[tag]
            if selector is False:
                self.pos += struct.calcsize(fmt)
                return None
            return self.number(fmt)
        if tag in (7, 11, 12):
            size = self.number("i") * {7: 1, 11: 4, 12: 8}[tag]
            if selector is False:
                self.pos += size
                return None
            return self.take(size)
        if tag == 8:
            if selector is False:
                size = self.number("H")
                self.pos += size
                return None
            return self.string()
        if tag == 9:
            item_type = self.number("B")
            size = self.number("i")
            if selector is False:
                for _ in range(size):
                    self.payload(item_type, False)
                return None
            return [self.payload(item_type, selector) for _ in range(size)]
        if tag == 10:
            value = {}
            while subtag := self.number("B"):
                key = self.string()
                pick = selector.get(key, False) if isinstance(selector, dict) else selector
                item = self.payload(subtag, pick)
                if pick is not False:
                    value[key] = item
            return value if selector is not False else None
        raise ValueError(f"Unexpected NBT tag {tag}")

    def read(self, selector):
        tag = self.number("B")
        self.string()
        return self.payload(tag, selector)


def read_level():
    with gzip.open(ROOT / "level.dat", "rb") as source:
        return Nbt(source.read()).read({
            "Data": {"SpawnX": True, "SpawnY": True, "SpawnZ": True,
                     "version": True, "DataVersion": True},
            "FML": True,
        })


def ordinary_path(path):
    return path.exists() and not path.is_symlink() and not getattr(path.lstat(), "st_file_attributes", 0) & 0x400


def region_files(folder):
    if not folder.is_dir() or not ordinary_path(folder):
        return []
    return sorted(path for path in folder.glob("r.*.*.mca")
                  if re.fullmatch(r"r\.-?\d+\.-?\d+\.mca", path.name)
                  and ordinary_path(path))


def chunk_locations(path):
    _, rx, rz, _ = path.name.split(".")
    with path.open("rb") as source:
        locations = source.read(4096)
    for index, (location,) in enumerate(struct.iter_unpack(">I", locations)):
        if location:
            yield int(rx) * 32 + index % 32, int(rz) * 32 + index // 32, location >> 8


def scan_area(files):
    ids = Counter()
    metadata = Counter()
    tiles = Counter()
    entities = Counter()
    data_versions = Counter()
    errors = Counter()
    sections_count = 0
    count = 0
    for path, locations in files:
        content = path.read_bytes()
        for x, z, sector in locations:
            offset = sector * 4096
            try:
                size, encoding = struct.unpack_from(">IB", content, offset)
                compressed = content[offset + 5:offset + 4 + size]
                raw = {1: gzip.decompress, 2: zlib.decompress, 3: bytes}[encoding](compressed)
                chunk = Nbt(raw).read({
                    "DataVersion": True,
                    "Level": {
                        "Sections": {"Blocks": True, "Add": True, "Data": True},
                        "TileEntities": {"id": True}, "Entities": {"id": True},
                    },
                })
                data_versions[str(chunk.get("DataVersion"))] += 1
                level = chunk["Level"]
                tiles.update(t["id"] for t in level.get("TileEntities", []) if "id" in t)
                entities.update(t["id"] for t in level.get("Entities", []) if "id" in t)
                for section in level.get("Sections", []):
                    blocks = section.get("Blocks", b"")
                    marked = blocks.translate(BLOCK_MASK)
                    marked_indices = {match.start() for match in re.finditer(rb"[^\x00]", marked)}
                    if high := section.get("Add"):
                        for match in re.finditer(rb"[^\x00]", high):
                            index = match.start() * 2
                            byte = high[match.start()]
                            if byte & 15:
                                marked_indices.add(index)
                            if byte >> 4:
                                marked_indices.add(index + 1)
                    data = section.get("Data", bytes(2048))
                    for index in marked_indices:
                        shift = (index % 2) * 4
                        upper = ((high[index // 2] >> shift) & 15) if high else 0
                        block = blocks[index] | (upper << 8)
                        meta = (data[index // 2] >> shift) & 15
                        ids[block] += 1
                        metadata[(block, meta)] += 1
                    sections_count += 1
                count += 1
            except (KeyError, ValueError, IndexError, struct.error, zlib.error, OSError) as error:
                errors[f"{type(error).__name__}: {error}"] += 1
    return {
        "chunks_read": count, "sections_read": sections_count, "errors": dict(errors),
        "data_versions": dict(data_versions), "block_ids_over_145": ids.most_common(),
        "variants_over_145": [[block, meta, n] for (block, meta), n in metadata.most_common()],
        "tile_entities": tiles.most_common(), "entities": entities.most_common(),
    }


def main():
    level = read_level()
    data = level["Data"]
    fml = level.get("FML", {})
    items = fml.get("ModItemData", [])
    data["FML_keys"] = sorted(fml)
    data["FML_item_keys"] = sorted(items[0]) if items else []
    data["FML_items"] = items
    data["FML_mod_list"] = fml.get("ModList", [])
    world_stats = {}
    target = []
    spawn_x = data["SpawnX"]
    spawn_z = data["SpawnZ"]
    for dimension in (".", "start_region", "DIM-1", "DIM-19", "DIM1", "DIM7",
                      "equestria_nether", "MoCWyvernLair", "testworld"):
        parent = ROOT / dimension
        if not ordinary_path(parent):
            continue
        paths = region_files(parent / "region")
        chunks = []
        for path in paths:
            locations = list(chunk_locations(path))
            chunks.extend((x, z) for x, z, _ in locations)
            if dimension != ".":
                continue
            selected = [(x, z, offset) for x, z, offset in locations
                        if abs(x - spawn_x // 16) <= 16 and abs(z - spawn_z // 16) <= 16]
            if selected:
                target.append((path, selected))
        result = {"files": len(paths), "bytes": sum(path.stat().st_size for path in paths),
                  "chunks": len(chunks)}
        if chunks:
            result["chunk_x"] = [min(x for x, z in chunks), max(x for x, z in chunks)]
            result["chunk_z"] = [min(z for x, z in chunks), max(z for x, z in chunks)]
        world_stats[dimension] = result
    report = {"level": data, "regions": world_stats, "spawn_sample": scan_area(target)}
    REPORT.write_text(json.dumps(report, indent=2), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        report_path("honeymoon-inventory-error.txt").write_text(traceback.format_exc(), encoding="utf-8")
        raise
