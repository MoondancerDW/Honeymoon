import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export function loadSnowCleanup(directory, sourceHash) {
  let data;
  try {
    data = readFileSync(join(directory,'snow-cleanup.json'));
  } catch (error) {
    if (error.code === 'ENOENT') return {hash:sourceHash, apply() {}};
    throw error;
  }
  const {version,world,chunks} = JSON.parse(data);
  if (version !== 1 || world !== sourceHash || !chunks || typeof chunks !== 'object') throw new Error('Invalid snow cleanup');
  const hash = createHash('sha256').update(`${sourceHash}\nsnow-cleanup\n`).update(data).digest('hex');
  function apply(chunk, palette) {
    const indices = chunks[`${chunk.x}.${chunk.z}`];
    if (!indices) return;
    const sections = new Map();
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index > 65535) throw new Error('Invalid snow cleanup cell');
      const y = index >> 12;
      if (!sections.has(y)) {
        const section = chunk.sections.find(section => section.y === y);
        if (!section) throw new Error('Snow cleanup references a missing section');
        sections.set(y,{section, bytes:Buffer.from(section.indices,'base64')});
      }
      const bytes = sections.get(y).bytes;
      const offset = (index & 4095) * 2;
      if (!(chunk.palette ?? palette)[bytes.readUInt16LE(offset)]?.startsWith('legacy:78:')) {
        throw new Error('Snow cleanup references a different cell');
      }
      bytes.writeUInt16LE(0,offset);
    }
    for (const {section,bytes} of sections.values()) section.indices = bytes.toString('base64');
  }
  return {hash,apply};
}
