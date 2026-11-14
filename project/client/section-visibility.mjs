const SIZE = 16;
const CELLS = SIZE ** 3;
const ALL_FACES = 63;
const SOLID = 64;
const VISITING = 128;
const AXIS_STEPS = [-1, 1, -256, 256, -16, 16];
const DIRECTIONS = [[-1,0,0], [1,0,0], [0,-1,0], [0,1,0], [0,0,-1], [0,0,1]];
const sectionId = (x, y, z) => `${x},${y},${z}`;

export function isOcclusionBlock(box) {
  return Boolean(box && box.solid && box.mode === 'opaque' && !box.angle && !box.kind && !box.approximation &&
    !box.redPowerOffset &&
    box.x0 === 0 && box.y0 === 0 && box.z0 === 0 && box.x1 === 1 && box.y1 === 1 && box.z1 === 1 &&
    box.faces?.length === 6 && box.faces.every(face => Number.isInteger(face) && face >= 0));
}

export function buildSectionVisibility(cells, solidCount) {
  if (!solidCount) return null;
  if (solidCount === CELLS) return {links: new Uint8Array(6), sealed: true};
  const links = new Uint8Array(6);
  const queue = new Uint16Array(CELLS);
  for (let seed = 0; seed < CELLS; seed++) {
    if (cells[seed]) continue;
    let start = 0, end = 0, faces = 0;
    cells[seed] = VISITING;
    queue[end++] = seed;
    while (start < end) {
      const index = queue[start++];
      const x = index & 15, y = index >> 8, z = index >> 4 & 15;
      const boundary = Number(x === 0) | Number(x === 15) << 1 | Number(y === 0) << 2 |
        Number(y === 15) << 3 | Number(z === 0) << 4 | Number(z === 15) << 5;
      faces |= boundary;
      for (let face = 0; face < 6; face++) {
        if (boundary & 1 << face) continue;
        const next = index + AXIS_STEPS[face];
        if (cells[next]) continue;
        cells[next] = VISITING;
        queue[end++] = next;
      }
    }
    for (let face = 0; face < 6; face++) if (faces & 1 << face) links[face] |= faces;
    if (faces === ALL_FACES && end + solidCount === CELLS) return null;
    // The camera needs its own component rather than all of the section's
    // openings. This matters when a room shares a section with open sky.
    for (let i = 0; i < end; i++) cells[queue[i]] = faces || VISITING;
  }
  return {links, cells};
}

export function markOcclusionBlock(cells, x, y, z) {
  cells[x + 16 * z + 256 * y] = SOLID;
}

function eyeFaces(data, x, y, z) {
  if (!data) return ALL_FACES;
  if (data.sealed) return null;
  const faces = data.cells[(x & 15) + 16 * (z & 15) + 256 * (y & 15)];
  return faces === SOLID ? null : faces & ALL_FACES;
}

// Every route that could contain a sight line remains possible. Linking whole
// faces permits extra detours, including paths around corners. Sections that
// end a path stay visible so the blocking wall is still drawn.
export function visibleSections(sections, x, y, z, radius, exits) {
  const width = radius * 2 + 1;
  const layer = width ** 2;
  const volume = layer * SIZE;
  const observed = new Uint8Array(volume);
  const pending = new Uint8Array(volume);
  const traversed = new Uint8Array(volume);
  const queue = new Uint32Array(volume * 6 + 1);
  const minX = x - radius, minZ = z - radius;
  const steps = [-1, 1, -layer, layer, -width, width];
  const origin = radius + radius * width + y * layer;
  let start = 0, end = 0;
  observed[origin] = 1;
  if (exits) {
    pending[origin] = exits;
    queue[end++] = origin;
  }
  while (start < end) {
    const current = queue[start++];
    let outgoing = pending[current];
    pending[current] = 0;
    traversed[current] |= outgoing;
    const cx = current % width;
    const cy = Math.floor(current / layer);
    const cz = Math.floor(current / width) % width;
    // A straight camera ray can never return toward its own section on any axis.
    if (cx !== radius) outgoing &= ~(cx < radius ? 2 : 1);
    if (cy !== y) outgoing &= ~(cy < y ? 8 : 4);
    if (cz !== radius) outgoing &= ~(cz < radius ? 32 : 16);
    for (let face = 0; face < 6; face++) {
      if (!(outgoing & 1 << face)) continue;
      const direction = DIRECTIONS[face];
      const nx = cx + direction[0], ny = cy + direction[1], nz = cz + direction[2];
      if (nx < 0 || nx >= width || ny < 0 || ny >= SIZE || nz < 0 || nz >= width) continue;
      const next = current + steps[face];
      observed[next] = 1;
      const visibility = sections.get(sectionId(minX + nx, ny, minZ + nz));
      const openings = (visibility?.links[face ^ 1] ?? ALL_FACES) & ~(pending[next] | traversed[next]);
      if (!openings) continue;
      if (!pending[next]) queue[end++] = next;
      pending[next] |= openings;
    }
  }
  return {seen: (sx, sy, sz) => {
    // Near geometry stays visible even from positions on a section boundary.
    if (Math.max(Math.abs(sx-x), Math.abs(sy-y), Math.abs(sz-z)) <= 1) return true;
    if (sx < minX || sx >= minX + width || sz < minZ || sz >= minZ + width || sy < 0 || sy >= SIZE) return true;
    return observed[sx-minX + (sz-minZ)*width + sy*layer] !== 0;
  }};
}

export class SectionVisibility {
  constructor() {
    this.sections = new Map();
    this.known = new Set();
    this.enabled = false;
    this.revision = 0;
    this.resetCounter();
  }

  resetCounter() {
    this.culled = 0;
    this.total = 0;
    this.buildMs = 0;
    this.rebuilds = 0;
  }

  setEnabled(enabled) {
    enabled = Boolean(enabled);
    if (enabled === this.enabled) return false;
    this.enabled = enabled;
    if (!enabled) {
      this.sections.clear();
      this.known.clear();
    }
    this.last = null;
    this.dirty = true;
    this.resetCounter();
    return true;
  }

  install(id, data) {
    if (!this.enabled) return;
    this.known.add(id);
    const previous = this.sections.has(id);
    if (data) this.sections.set(id, data);
    else this.sections.delete(id);
    if (data || previous) this.revision++;
  }

  invalidate(id) {
    if (!this.known.delete(id)) return;
    this.sections.delete(id);
    if (!this.enabled) return;
    // Eviction removes groups even for an all-connected section. An edit can
    // expose other sections before the worker builds its new blockage map.
    this.last = null;
    this.dirty = true;
  }

  update(eye, radius, now) {
    if (!this.dirty && !this.enabled) return false;
    const dirty = this.dirty;
    this.dirty = false;
    if (!this.enabled) return true;
    const bx = Math.floor(eye.x), by = Math.floor(eye.y), bz = Math.floor(eye.z);
    const x = bx >> 4, y = by >> 4, z = bz >> 4;
    const exits = y < 0 || y >= SIZE ? null : eyeFaces(this.sections.get(sectionId(x,y,z)), bx,by,bz);
    const previous = this.last;
    const sameOrigin = previous?.x === x && previous?.y === y && previous?.z === z &&
      previous?.exits === exits && previous?.radius === radius;
    if (sameOrigin && (previous.revision === this.revision || now - previous.at < 100)) return dirty;
    const begin = performance.now();
    this.last = {x,y,z,exits,radius,revision:this.revision,at:now,
      ...(exits !== null && visibleSections(this.sections, x,y,z,radius,exits))};
    this.buildMs = performance.now() - begin;
    this.rebuilds++;
    return true;
  }

  visible(x, y, z) {
    if (!this.enabled) return true;
    return this.last?.seen?.(x,y,z) ?? true;
  }

  statistics() {
    return {enabled:this.enabled, classifiedSections:this.known.size, obstructingSections:this.sections.size,
      culled:this.culled, total:this.total, traversalMs:this.buildMs, rebuilds:this.rebuilds};
  }
}
