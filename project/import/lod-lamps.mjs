const decoded = new WeakMap();
const trimMaterial = 28;
const faceMaterial = 7;
const shellSlots = [
  [[13, 23, 11], [25, 1, 24], [12, 22, 10]],
  [[21, 3, 19], [5, -1, 4], [20, 2, 18]],
  [[9, 15, 7], [17, 0, 16], [8, 14, 6]],
];
const keyOf = (x, z) => `${x},${z}`;
const pointKey = (x, y, z) => `${x},${y},${z}`;

function decode(chunk) {
  if (decoded.has(chunk)) return decoded.get(chunk);
  const glowstone = chunk.palette.indexOf('legacy:89:0');
  const centers = [];
  const sections = new Map();
  for (const section of chunk.sections) {
    const bytes = Buffer.from(section.indices, 'base64');
    const indices = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.length / 2);
    sections.set(section.y, indices);
    if (glowstone < 0) continue;
    for (let index = 0; index < indices.length; index++) {
      if (indices[index] !== glowstone) continue;
      centers.push([chunk.x * 16 + (index & 15), section.y * 16 + (index >> 8),
        chunk.z * 16 + ((index >> 4) & 15)]);
    }
  }
  const result = {sections, centers};
  decoded.set(chunk, result);
  return result;
}

function sameParts(actual, required) {
  return actual?.length === required.length && required.every(expected =>
    actual.some(part => part.slot === expected.slot && part.material === expected.material &&
      part.shape === expected.shape && part.bounds === undefined));
}

// This street lantern has a glowstone core, six glass covers, a wooden cube
// rim, and a matching post/overhead bracket. Match the complete assembly so
// glass windows and unrelated glowstone ornaments retain their usual LOD.
function streetLantern(center, cellAt, direction) {
  const [sx, sz] = direction;
  const supports = new Map([
    [pointKey(sx, -1, sz), [26]],
    [pointKey(sx, 0, sz), [26]],
    [pointKey(0, 1, 0), [26, sx ? 28 : 27]],
    [pointKey(sx, 1, sz), [26, sx ? 28 : 27]],
  ]);
  const shell = [];
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy && !dz) continue;
    const point = [center[0] + dx, center[1] + dy, center[2] + dz];
    const cell = cellAt(...point);
    if (!cell?.key.startsWith('cover:750:0:')) return null;
    const slot = shellSlots[dy + 1][dz + 1][dx + 1];
    const required = [{slot, shape:0, material:slot < 6 ? faceMaterial : trimMaterial}];
    const extra = supports.get(pointKey(dx, dy, dz)) ?? [];
    required.push(...extra.map(slot => ({slot, shape:0, material:trimMaterial})));
    if (!sameParts(cell.parts, required)) return null;
    shell.push({point, key:extra.length ? 'cover-material:28' : 'air'});
  }
  for (const dy of [-2, -3, -4]) {
    const point = [center[0] + sx, center[1] + dy, center[2] + sz];
    const cell = cellAt(...point);
    if (!sameParts(cell?.parts, [{slot:26, shape:dy === -4 ? 1 : 0, material:trimMaterial}])) return null;
    shell.push({point, key:'cover-material:28'});
  }
  return shell;
}

export function lampCoverOverrides(chunk, neighbors = []) {
  const chunks = [chunk, ...neighbors];
  const sources = new Map(chunks.map(source => [keyOf(source.x, source.z), source]));
  const x0 = chunk.x * 16, z0 = chunk.z * 16;
  const centers = chunks.flatMap(source => decode(source).centers).filter(([x,,z]) =>
    x >= x0 - 1 && x <= x0 + 16 && z >= z0 - 1 && z <= z0 + 16);
  const replacements = new Map();
  if (!centers.length) return replacements;
  const cellAt = (x,y,z) => {
    const source = sources.get(keyOf(x >> 4, z >> 4));
    if (!source) return null;
    const index = (x & 15) + (z & 15) * 16 + (y & 15) * 256;
    const paletteIndex = decode(source).sections.get(y >> 4)?.[index];
    const key = source.palette[paletteIndex] ?? 'air';
    return {key, parts:source.compositions?.[key]?.parts};
  };
  for (const center of centers) {
    for (const direction of [[0,1], [0,-1], [1,0], [-1,0]]) {
      const shell = streetLantern(center, cellAt, direction);
      if (!shell) continue;
      for (const {point:[x,y,z], key} of shell) {
        if (x >> 4 !== chunk.x || z >> 4 !== chunk.z) continue;
        replacements.set(y * 256 + (z & 15) * 16 + (x & 15), key);
      }
      break;
    }
  }
  return replacements;
}
