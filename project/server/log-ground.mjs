import {grassBlock, isTreeLog, plainDirt} from '../world/tree-logs.mjs';

const layer = 16 * 16;
const sectionCells = layer * 16;

export function applyLogGround(chunk, defaultPalette) {
  const palette = chunk.palette ?? defaultPalette;
  const dirt = palette.indexOf(plainDirt);
  if (dirt < 0) return 0;
  const logs = new Set();
  for (const [index,key] of palette.entries()) {
    if (isTreeLog(key)) logs.add(index);
  }
  if (!logs.size) return 0;

  const sections = new Map(chunk.sections.map(section => {
    const bytes = Buffer.from(section.indices,'base64');
    if (bytes.length !== sectionCells * 2) throw new Error('Malformed section for log ground');
    return [section.y,{section,bytes}];
  }));
  const changed = new Set();
  let grass = palette.indexOf(grassBlock);
  let count = 0;
  for (const [y,current] of sections) {
    const lower = sections.get(y - 1);
    for (let index = lower ? 0 : layer; index < sectionCells; index++) {
      if (!logs.has(current.bytes.readUInt16LE(index * 2))) continue;
      const ground = index < layer ? lower : current;
      const groundIndex = index < layer ? index + sectionCells - layer : index - layer;
      const offset = groundIndex * 2;
      if (ground.bytes.readUInt16LE(offset) !== dirt) continue;
      if (grass < 0) {
        grass = palette.length;
        chunk.palette = [...palette,grassBlock];
      }
      ground.bytes.writeUInt16LE(grass,offset);
      changed.add(ground);
      count++;
    }
  }
  for (const {section,bytes} of changed) section.indices = bytes.toString('base64');
  return count;
}
