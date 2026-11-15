import { gunzipSync, inflateSync } from 'node:zlib';

const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
const SECTOR_BYTES = 4096;
const decodeModified = /[\xc0\xed]/;

function modifiedUtf8(bytes) {
  // DataInput.readUTF stores supplementary code points as UTF-16 surrogate pairs.
  const latin = bytes.toString('latin1');
  if (!decodeModified.test(latin)) return bytes.toString('utf8');
  let value = '';
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const a = bytes[index];
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    if (a === 0xc0 && b === 0x80) {
      value += bytes.toString('utf8', start, index) + '\0';
      start = index + 2;
      index += 1;
    } else if (a === 0xed && b >= 0xa0 && b <= 0xbf && c >= 0x80 && c <= 0xbf) {
      value += bytes.toString('utf8', start, index) + String.fromCharCode(
        ((a & 15) << 12) | ((b & 63) << 6) | (c & 63),
      );
      start = index + 3;
      index += 2;
    }
  }
  return value + bytes.toString('utf8', start);
}

class NbtReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  number(method, width) {
    const value = this.bytes[method](this.offset);
    this.offset += width;
    return value;
  }

  take(length) {
    if (length < 0 || this.offset + length > this.bytes.length) {
      throw new RangeError(`Invalid NBT payload length ${length} at ${this.offset}`);
    }
    const start = this.offset;
    this.offset += length;
    return this.bytes.subarray(start, this.offset);
  }

  string() {
    return modifiedUtf8(this.take(this.number('readUInt16BE', 2)));
  }

  payload(type, depth) {
    if (depth > 128) throw new RangeError('NBT exceeds maximum nesting');
    switch (type) {
      case 1: return this.number('readInt8', 1);
      case 2: return this.number('readInt16BE', 2);
      case 3: return this.number('readInt32BE', 4);
      case 4: return { $nbt: 'long', value: this.number('readBigInt64BE', 8).toString() };
      case 5: return this.number('readFloatBE', 4);
      case 6: return this.number('readDoubleBE', 8);
      case 7: return this.take(this.number('readInt32BE', 4));
      case 8: return this.string();
      case 9: {
        const elementType = this.number('readUInt8', 1);
        const length = this.number('readInt32BE', 4);
        if (length <= 0) return [];
        if (elementType === 0 || length > this.bytes.length - this.offset) {
          throw new RangeError(`Invalid NBT list length ${length} for tag ${elementType}`);
        }
        return Array.from({ length }, () => this.payload(elementType, depth + 1));
      }
      case 10: {
        const compound = Object.create(null);
        for (let tag = this.number('readUInt8', 1); tag; tag = this.number('readUInt8', 1)) {
          const key = this.string();
          compound[key] = this.payload(tag, depth + 1);
        }
        return compound;
      }
      case 11:
      case 12: {
        const length = this.number('readInt32BE', 4);
        const bytes = this.take(length * (type === 11 ? 4 : 8));
        return { $nbt: type === 11 ? 'ints' : 'longs', base64: bytes.toString('base64') };
      }
      default: throw new RangeError(`Invalid NBT tag ${type}`);
    }
  }
}

export function readNbt(bytes) {
  const reader = new NbtReader(bytes);
  if (reader.number('readUInt8', 1) !== 10) throw new Error('NBT root must be a compound');
  reader.string();
  return reader.payload(10, 0);
}

export function readRegionChunk(region, cx, cz) {
  const slot = (cx & 31) + 32 * (cz & 31);
  if (region.length < 2 * SECTOR_BYTES) throw new Error('Incomplete region header');
  const location = region.readUInt32BE(slot * 4);
  if (location === 0) return null;
  const sector = location >>> 8;
  const count = location & 255;
  const start = sector * SECTOR_BYTES;
  if (sector < 2 || count < 1 || start + 5 > region.length) {
    throw new Error(`Invalid region sector ${sector} count ${count}`);
  }
  const length = region.readUInt32BE(start);
  const end = start + 4 + length;
  if (length < 1 || end > region.length || end > start + count * SECTOR_BYTES) {
    throw new Error(`Invalid region chunk length ${length} at sector ${sector}`);
  }
  const encoding = region[start + 4];
  const compressed = region.subarray(start + 5, end);
  let raw;
  if (encoding === 1) raw = gunzipSync(compressed, { maxOutputLength: MAX_CHUNK_BYTES });
  else if (encoding === 2) raw = inflateSync(compressed, { maxOutputLength: MAX_CHUNK_BYTES });
  else if (encoding === 3) raw = compressed;
  else throw new Error(`Unsupported region chunk encoding ${encoding}`);
  const { Level: level } = readNbt(raw);
  if (level?.xPos !== cx || level?.zPos !== cz) {
    throw new Error(`Region index points to ${level?.xPos},${level?.zPos}, expected ${cx},${cz}`);
  }
  return level;
}

export function sectionBlocks(section) {
  const { Y: y, Blocks: low, Add: high, Data: metadata } = section;
  if (!Number.isInteger(y) || y < 0 || y > 15 || low?.length !== 4096 ||
      metadata?.length !== 2048 || (high && high.length !== 2048)) {
    throw new Error(`Invalid block array at section ${y}`);
  }
  const blocks = new Uint16Array(4096);
  const variants = new Uint8Array(4096);
  for (let index = 0; index < 4096; index += 1) {
    const half = index & 1;
    const upper = high ? (high[index >> 1] >>> (half * 4)) & 15 : 0;
    blocks[index] = low[index] | (upper << 8);
    variants[index] = (metadata[index >> 1] >>> (half * 4)) & 15;
  }
  return { blocks, variants };
}

export function coverParts(tile) {
  if (!Number.isInteger(tile.cvm) || !Buffer.isBuffer(tile.cvs)) return null;
  const mask = tile.cvm & (tile.id === 'RPFrame' ? 0x3f : 0x1fffffff);
  const parts = [];
  for (let slot = 0; slot < 29; slot++) {
    if (((mask >>> slot) & 1) === 0) continue;
    const offset = parts.length * 2;
    if (offset + 1 >= tile.cvs.length) break;
    parts.push({slot, material:tile.cvs[offset], shape:tile.cvs[offset + 1]});
  }
  const expectedLength = mask.toString(2).replaceAll('0', '').length * 2;
  return {parts, malformed:expectedLength !== tile.cvs.length};
}

export function canonicalJson(value) {
  if (Buffer.isBuffer(value)) return JSON.stringify({ $nbt: 'bytes', base64: value.toString('base64') });
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'number' && !Number.isFinite(value)) {
    return JSON.stringify({ $nbt: 'non-finite', value: String(value) });
  }
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
  return `{${entries.join(',')}}`;
}
