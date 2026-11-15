import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { crc32, inflate } from 'node:zlib';
import { maxSkinBytes, skinSizes } from '../world/pony-skins.mjs';
import { RequestError } from './errors.mjs';

export const MAX_PROFILE_BODY = Math.ceil(maxSkinBytes / 3) * 4 + 1024;
const MAX_PNG_CHUNKS = 512;
const stages = ['IHDR', 'PLTE', 'IDAT', 'IEND'];
const colorDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const colorChunks = { gAMA: 4, cHRM: 32, sRGB: 1 };
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const inflatePng = promisify(inflate);
const hash = value => createHash('sha256').update(value).digest('hex');
const invalidSkin = () => new RequestError(400, 'invalid_skin');

export function publicProfile(player, { nickname, skinHash } = {}) {
  const id = hash(`pony:${player}`).slice(0, 24);
  return { id, nickname: nickname ?? `Игрок ${id.slice(0, 5)}`, nicknameChosen: Boolean(nickname),
    skin: skinHash ? `/skins/${skinHash}.png` : null };
}

function scanlineLayout(width, height, bits, interlaced) {
  const passes = interlaced
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]];
  return passes.map(([x, y, dx, dy]) => ({
    rows: Math.ceil((height - y) / dy),
    bytes: 1 + Math.ceil(Math.ceil((width - x) / dx) * bits / 8),
  }));
}

async function readSkin(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw invalidSkin();
  const original = Buffer.from(value, 'base64');
  if (original.length > maxSkinBytes) throw new RequestError(413, 'skin_too_large');
  if (!original.subarray(0, signature.length).equals(signature)) throw invalidSkin();
  const retained = [signature];
  const imageData = [];
  const adjustments = new Set();
  let stage = -1, paletteEntries = 0, layout, colorType, bitDepth, hasTransparency = false;
  let start = signature.length;
  for (let chunks = 0; start < original.length; chunks++) {
    if (chunks >= MAX_PNG_CHUNKS || start + 12 > original.length) throw invalidSkin();
    const size = original.readUInt32BE(start), end = start + 12 + size;
    const name = original.toString('latin1', start + 4, start + 8);
    if (end > original.length) throw invalidSkin();
    if (stage === 3) {
      // Some legacy skin editors append text with a broken CRC after IEND. Discard it without interpreting it.
      if (name !== 'tEXt') throw invalidSkin();
      start = end;
      continue;
    }
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(name) ||
        crc32(original.subarray(start + 4, end - 4)) !== original.readUInt32BE(end - 4)) throw invalidSkin();
    const data = original.subarray(start + 8, end - 4);
    const nextStage = stages.indexOf(name);
    if (stage < 0 && name !== 'IHDR') throw invalidSkin();
    if (nextStage >= 0) {
      if (nextStage < stage || nextStage === stage && name !== 'IDAT') throw invalidSkin();
      stage = nextStage;
      if (name === 'IHDR') {
        if (size !== 13) throw invalidSkin();
        const width = data.readUInt32BE(0), height = data.readUInt32BE(4);
        if (!skinSizes.includes(`${width}x${height}`)) throw new RequestError(400, 'invalid_skin_size');
        bitDepth = data[8];
        colorType = data[9];
        if (!colorDepths[colorType]?.includes(bitDepth) || data[10] !== 0 || data[11] !== 0 || data[12] > 1) throw invalidSkin();
        layout = scanlineLayout(width, height, bitDepth * channels[colorType], data[12] === 1);
      } else if (name === 'PLTE') {
        paletteEntries = size / 3;
        const limit = colorType === 3 ? 2 ** bitDepth : 256;
        if (hasTransparency || colorType === 0 || colorType === 4 || size % 3 !== 0 ||
            paletteEntries < 1 || paletteEntries > limit) throw invalidSkin();
      } else if (name === 'IDAT') {
        if (colorType === 3 && !paletteEntries) throw invalidSkin();
        imageData.push(data);
      } else if (size !== 0 || !imageData.length) throw invalidSkin();
      retained.push(original.subarray(start, end));
    } else if (name === 'tRNS') {
      const transparencySize = colorType === 0 ? size === 2 : colorType === 2 ? size === 6 : colorType === 3 && size > 0 && size <= paletteEntries;
      if (stage >= 2 || hasTransparency || !transparencySize) throw invalidSkin();
      hasTransparency = true;
      retained.push(original.subarray(start, end));
    } else if (Object.hasOwn(colorChunks, name)) {
      if (stage !== 0 || size !== colorChunks[name] || adjustments.has(name)) throw invalidSkin();
      adjustments.add(name);
      retained.push(original.subarray(start, end));
    } else if (/^[A-Z]/.test(name)) throw invalidSkin();
    // Discard user metadata and animation chunks. Only the static skin is shared.
    start = end;
  }
  if (stage !== 3) throw invalidSkin();
  const expected = layout.reduce((sum, pass) => sum + pass.rows * pass.bytes, 0);
  const compressed = Buffer.concat(imageData);
  let image;
  try {
    image = await inflatePng(compressed, { maxOutputLength: expected, info: true });
  } catch {
    throw invalidSkin();
  }
  const pixels = image.buffer;
  if (pixels.length !== expected || image.engine.bytesWritten !== compressed.length) throw invalidSkin();
  let at = 0;
  for (const { rows, bytes } of layout) {
    for (let row = 0; row < rows; row++, at += bytes) {
      if (pixels[at] > 4) throw invalidSkin();
    }
  }
  const png = Buffer.concat(retained);
  return { png, hash: hash(png) };
}

export async function profileChanges({ nickname, skin }) {
  if (nickname !== undefined) {
    if (typeof nickname !== 'string') throw new RequestError(400, 'invalid_nickname');
    nickname = nickname.normalize('NFC').trim();
    if (!/^[\p{L}\p{M}\p{N} _-]{2,24}$/u.test(nickname) || !/[\p{L}\p{N}]/u.test(nickname)) {
      throw new RequestError(400, 'invalid_nickname');
    }
  }
  return { nickname, skin: skin === undefined || skin === null ? skin : await readSkin(skin) };
}
