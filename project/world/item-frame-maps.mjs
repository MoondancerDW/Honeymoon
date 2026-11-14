import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {readNbt} from '../import/nbt.mjs';

// Minecraft 1.4.7 MapColor and MapItemRenderer shade table.
const COLORS = [0, 8368696, 16247203, 0xa7a7a7, 0xff0000, 0xa0a0ff, 0xa7a7a7,
  31744, 0xffffff, 10791096, 12020271, 0x707070, 0x4040ff, 6837042];
const SHADES = [180, 220, 255, 220];

export function mapPixels({width, height, colors}) {
  if (width !== 128 || height !== 128 || colors?.length !== width * height) {
    throw new RangeError('Expected a 128×128 legacy item map');
  }
  const rgba = Buffer.alloc(colors.length * 4);
  for (const [index, pixel] of colors.entries()) {
    const base = pixel >> 2;
    if (!base) {
      rgba[index * 4 + 3] = 16 + ((index + (index >> 7)) & 1) * 8;
    } else {
      const color = COLORS[base];
      if (color === undefined) throw new RangeError(`Unknown legacy map color ${base}`);
      const shade = SHADES[pixel & 3] / 255;
      rgba[index * 4] = (color >> 16 & 255) * shade;
      rgba[index * 4 + 1] = (color >> 8 & 255) * shade;
      rgba[index * 4 + 2] = (color & 255) * shade;
      rgba[index * 4 + 3] = 255;
    }
  }
  return rgba;
}

const [source, ...ids] = process.argv.slice(2);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const maps = {};
  for (const id of ids) {
    if (!/^\d+$/.test(id)) throw new Error(`Invalid map ID ${id}`);
    const raw = readFileSync(join(source, 'data', `map_${id}.dat`), {throwIfNoEntry: false});
    if (raw) maps[id] = mapPixels(readNbt(gunzipSync(raw)).data).toString('base64');
  }
  console.log(JSON.stringify(maps));
}
