from bundle_paths import report_path
import json, gzip, zlib, struct, zipfile
from pathlib import Path
from collections import Counter
from honeymoon_inventory import Nbt, ROOT, region_files, chunk_locations, read_level

def main():
    registry = {r["ItemId"]: r for r in read_level()["FML"]["ModItemData"]}
    ids, variants, tiles, entities, covers, pair0, pair1, cover_parts = (Counter() for _ in range(8))
    examples = {}
    for path in region_files(ROOT / "region"):
        locations = [l for l in chunk_locations(path) if -4 <= l[0] < 4 and -4 <= l[1] < 4]
        if not locations:
            continue
        content = path.read_bytes()
        for x,z,offset in locations:
            start = offset*4096
            length,kind=struct.unpack_from(">IB",content,start)
            raw={1:gzip.decompress,2:zlib.decompress,3:bytes}[kind](content[start+5:start+4+length])
            level=Nbt(raw).read({"Level":{
                "Sections":{"Blocks":True,"Add":True,"Data":True},
                "TileEntities":{"id":True,"x":True,"y":True,"z":True,"cvm":True,"cvs":True},
                "Entities":{"id":True}
            }})["Level"]
            for sec in level["Sections"]:
                high=sec.get("Add",bytes(2048))
                data=sec["Data"]
                for i,low in enumerate(sec["Blocks"]):
                    shift=(i%2)*4
                    block=low|(((high[i//2]>>shift)&15)<<8)
                    meta=(data[i//2]>>shift)&15
                    ids[block]+=1
                    variants[block,meta]+=1
            for tile in level.get("TileEntities",[]):
                name=tile["id"]
                tiles[name]+=1
                examples.setdefault(name,{k:tile[k] for k in ("x","y","z") if k in tile})
                if name=="Covers":
                    covers[tile["cvm"],tile["cvs"]]+=1
                    pair0.update(tile["cvs"][::2])
                    pair1.update(tile["cvs"][1::2])
                    cover_parts[tile["cvm"].bit_count()]+=1
            entities.update(e["id"] for e in level.get("Entities",[]))
    groups=Counter()
    for block,n in ids.items():
        groups[registry.get(block,{}).get("ModId","Minecraft" if block<=145 else "unknown")]+=n
    out={"bounds":[-64,63,-64,63],"distinct_ids":len(ids),"distinct_variants":len(variants),
         "groups":groups.most_common(),"mod_ids":[
             {"id":block,"count":n,"registry":registry.get(block)} for block,n in ids.most_common() if block>145],
         "tiles":tiles.most_common(),"entities":entities.most_common(),"examples":examples,
         "covers_distinct":len(covers),"cover_parts":cover_parts.most_common(),
         "cover_pair_byte0":pair0.most_common(),"cover_pair_byte1":pair1.most_common()}
    pack=ROOT.parent.parent/"texturepacks"/"My-Little-Ponyach-147f.zip"
    with zipfile.ZipFile(pack) as z:
        out["relevant_textures"]=[name for name in z.namelist()
            if name.lower().endswith(".png") and name.startswith(("eloraam/","mods/","terrain","ctm","misc/"))]
    report_path("honeymoon-core-crop-audit.json").write_text(json.dumps(out,indent=2),encoding="utf8")
if __name__=="__main__":
    main()
