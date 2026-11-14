const HEADER = 72;
const RECORD = 16;
const CHUNKS = 16;

export function decodeFarTile(buffer) {
  const view = new DataView(buffer);
  if (view.byteLength < HEADER || view.getUint32(0) !== 0x484c4f44 ||
      view.getUint16(4, true) !== 1 || view.getUint8(6) !== 4 || view.getUint8(7) !== RECORD ||
      (view.byteLength - HEADER) % RECORD) throw new Error('Invalid far terrain tile');
  const counts = new Uint32Array(CHUNKS);
  let total = 0;
  for (let index = 0; index < CHUNKS; index++) {
    counts[index] = view.getUint32(8 + 4 * index, true);
    total += counts[index];
  }
  if (total !== (view.byteLength - HEADER) / RECORD) throw new Error('Invalid far terrain tile size');

  let water = 0;
  for (let offset = HEADER; offset < view.byteLength; offset += RECORD) {
    if (view.getUint8(offset + 8) & 128) water++;
  }
  function layer(count) {
    return {count, at:0, offset:new Uint16Array(count * 3), span:new Uint16Array(count * 2),
      surface:new Uint16Array(count * 2), light:new Uint16Array(count), color:new Uint8Array(count * 3),
      minY:256, maxY:0};
  }
  const layers = [layer(total - water), layer(water)];
  const heightAxes = [[2,1], [1,2], [0,2], [2,0], [1,0], [0,1]];
  let byte = HEADER;
  for (let chunk = 0; chunk < CHUNKS; chunk++) {
    const x = (chunk & 3) * 16, z = (chunk >> 2) * 16;
    for (let i = 0; i < counts[chunk]; i++, byte += RECORD) {
      const flags = view.getUint8(byte + 8);
      const face = flags & 7;
      if (face >= 6 || flags & 0x78) throw new Error('Invalid far terrain face');
      const data = layers[flags >> 7];
      const at = data.at++;
      const y = view.getUint16(byte + 2, true);
      const width = view.getUint16(byte + 4, true);
      const height = view.getUint16(byte + 6, true);
      data.offset[at * 3] = x + view.getUint8(byte);
      data.offset[at * 3 + 1] = y;
      data.offset[at * 3 + 2] = z + view.getUint8(byte + 1);
      data.span[at * 2] = width;
      data.span[at * 2 + 1] = height;
      data.surface[at * 2] = view.getUint16(byte + 9, true);
      data.surface[at * 2 + 1] = face + chunk * 8;
      data.light[at] = view.getUint16(byte + 11, true);
      data.color[at * 3] = view.getUint8(byte + 13);
      data.color[at * 3 + 1] = view.getUint8(byte + 14);
      data.color[at * 3 + 2] = view.getUint8(byte + 15);
      data.minY = Math.min(data.minY, y);
      const [u, v] = heightAxes[face];
      data.maxY = Math.max(data.maxY, y + (u === 1 ? width : v === 1 ? height : 0));
    }
  }
  return {counts, layers, bytes:total * 19, triangles:total * 2};
}

export function farVisibilityMask(regionX, regionZ, exact, counts) {
  let mask = 0;
  for (let i = 0; i < CHUNKS; i++) {
    if (counts[i] && !exact(regionX * 4 + (i & 3), regionZ * 4 + (i >> 2))) mask |= 1 << i;
  }
  return mask;
}
