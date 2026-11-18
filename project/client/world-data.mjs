import {lightChanged, updateBlockLight} from './block-light.mjs';
import {skyCellProfile,skyProfile,updateSkyAccess} from './sky-access.mjs';
import {detailCoverage} from '../world/full-detail.mjs';

export const chunkKey = (x, z) => x + ',' + z;
export const sectionKey = (x, y, z) => x + ',' + y + ',' + z;
export const cellKey = sectionKey;
const blockIndex = (x, y, z) => (x & 15) + (z & 15) * 16 + (y & 15) * 256;
const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function decodeBytes(encoded) {
  if (!encoded) return null;
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(encoded);
  const input = atob(encoded);
  const bytes = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) bytes[i] = input.charCodeAt(i);
  return bytes;
}

export function decodeIndices(encoded) {
  const bytes = decodeBytes(encoded);
  if (littleEndian) return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const indices = new Uint16Array(bytes.length / 2);
  for (let i = 0; i < indices.length; i++) indices[i] = input.getUint16(i * 2, true);
  return indices;
}

export async function json(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    const error=new Error(url + ' — ' + response.status);
    error.status=response.status;
    throw error;
  }
  return response.json();
}

export function droppedItemPosition({start, target, at, duration}, now) {
  const phase = Math.max(0,Math.min(1,(now - at) / duration));
  return start.map((value,index) => value + (target.position[index] - value) * phase);
}

export class World {
  constructor(manifest) {
    this.manifest = manifest;
    this.playableChunks = new Set((manifest.chunks ?? []).map(([x,z])=>chunkKey(x,z)));
    this.fullCoverage = detailCoverage(manifest.fullChunks);
    this.palette = manifest.palette.slice();
    this.indices = new Map(this.palette.map((key, index) => [key, index]));
    this.chunks = new Map();
    this.minecarts = new Map();
    this.boats = new Map();
    this.frames = new Map();
    this.droppedItems = new Map();
    this.frameRevision = -1;
    this.minecartSnapshotTime = undefined;
    this.overrides = new Map();
    this.overridesByChunk = new Map();
    this.upperOverrides = new Map();
    this.upperRevision = 0;
    this.blockLightOverrides = new Map();
    this.pendingLights = new Map();
    this.skyLightOverrides = new Map();
    this.pendingSky = new Map();
  }

  isPlayableChunk(x,z) {
    return this.playableChunks.has(chunkKey(x,z)) || this.manifest.fullWorldPlayable && this.fullCoverage(x,z);
  }

  playableAround(x,z,radius) {
    const result=[];
    for (let dz=-radius;dz<=radius;dz++) for (let dx=-radius;dx<=radius;dx++) {
      if (this.isPlayableChunk(x+dx,z+dz)) result.push([x+dx,z+dz]);
    }
    return result;
  }

  setFrames(frames,revision) {
    if (revision <= this.frameRevision) return;
    this.frameRevision = revision;
    this.frames = new Map(frames.map(frame => [frame.key,frame]));
  }

  setDroppedItems(entities,now) {
    const duration = Math.min(100,Math.max(40,now - (this.droppedItemSnapshotTime ?? now - 50)));
    this.droppedItemSnapshotTime = now;
    const next = new Map(entities.map(target => {
      const previous = this.droppedItems.get(target.key);
      const start = previous ? droppedItemPosition(previous,now) : target.position;
      return [target.key,{start,target,at:now,duration}];
    }));
    this.droppedItems = next;
  }

  setMinecarts(entities, now, boats = []) {
    const duration = Math.min(150, Math.max(50, now - (this.minecartSnapshotTime ?? now - 100)));
    this.minecartSnapshotTime = now;
    const interpolate = (targets,previousTargets) => new Map(targets.map(target => {
      const existing = previousTargets.get(target.key)?.entity;
      const previous = existing && Math.hypot(...target.position.map((value, axis) => value - existing.position[axis])) < 3
        ? existing : target;
      const position = [...previous.position];
      const rotation = [previous.data.Rotation?.[0] ?? 0, previous.data.Rotation?.[1] ?? 0];
      const targetYaw = target.data.Rotation?.[0] ?? 0;
      const yawOffset = ((targetYaw - rotation[0] + 540) % 360 + 360) % 360 - 180;
      const entity = {...target, position:[...position], data:{...target.data, Rotation:[...rotation]}};
      return [target.key,{entity,position,rotation,target,yawOffset,at:now,duration}];
    }));
    this.minecarts = interpolate(entities,this.minecarts);
    this.boats = interpolate(boats,this.boats);
  }

  stepMinecarts(now) {
    for (const vehicles of [this.minecarts,this.boats]) {
      for (const {entity,position,rotation,target,yawOffset,at,duration} of vehicles.values()) {
        const progress = Math.min(1,Math.max(0,(now-at)/duration));
        for (let axis = 0; axis < 3; axis++) entity.position[axis] = position[axis] + (target.position[axis]-position[axis])*progress;
        entity.data.Rotation[0] = rotation[0] + yawOffset*progress;
        entity.data.Rotation[1] = rotation[1] + ((target.data.Rotation?.[1] ?? 0)-rotation[1])*progress;
      }
    }
  }

  addChunk(chunk, visualOnly = false) {
    const sections = new Map(chunk.sections.map(({y, indices, skyLight, blockLight}) => [y, {
      indices: decodeIndices(indices), sky: decodeBytes(skyLight), block: decodeBytes(blockLight)
    }]));
    const stored = {x: chunk.x, z: chunk.z, sections, visualOnly, entities: chunk.entities || [],
      palette: chunk.palette, compositions: chunk.compositions, highOnly:chunk.highOnly===true};
    stored.hasSky = [...sections.values()].some(section=>section.sky);
    stored.skyTop = (Math.max(-1,...sections.keys())<<4)+15;
    for (const edit of this.editsInChunk(chunk.x,chunk.z)) stored.skyTop=Math.max(stored.skyTop,edit.y);
    this.chunks.set(chunkKey(chunk.x, chunk.z), stored);
    const objects = new Map();
    for (const object of chunk.objects || []) {
      const [x, y, z] = object.position;
      let layer = objects.get(y >> 4);
      if (!layer) { layer = new Map(); objects.set(y >> 4, layer); }
      layer.set(blockIndex(x, y, z), object);
    }
    stored.objects = objects;
    return stored;
  }

  addPalette(key) {
    if (this.indices.has(key)) return this.indices.get(key);
    if (!this.manifest.chunkPalettes && this.palette.length >= 65536) throw new Error('Palette exceeds uint16');
    const index = this.palette.length;
    this.palette.push(key);
    this.indices.set(key, index);
    return index;
  }

  setOverride(change) {
    const position = cellKey(change.x, change.y, change.z);
    const previous = this.overrides.get(position);
    if (previous && previous.revision >= change.revision) return false;
    const key = change.cell || 'air';
    const {x, y, z} = change;
    const coordinates = chunkKey(x >> 4, z >> 4);
    const chunk = this.chunks.get(coordinates);
    if (chunk && lightChanged(this.lightCell(x, y, z), {key, object: change.object, voxels: change.voxels, fluid: change.fluid})) {
      if (!this.pendingLights.has(position)) this.pendingLights.set(position, [x, y, z, this.lightAt(x, y, z) & 15]);
    }
    if (chunk?.hasSky && !chunk.visualOnly) {
      const parts=change.parts ?? (chunk.compositions ?? this.manifest.compositions)?.[key]?.parts;
      if (skyCellProfile(this,x,y,z,false,chunk) !== skyProfile({...change,key,parts})) this.pendingSky.set(position,[x,y,z]);
      chunk.skyTop=Math.max(chunk.skyTop,y);
    }
    const override = {...change, index: this.addPalette(key)};
    let entries = this.overridesByChunk.get(coordinates);
    if (!entries) this.overridesByChunk.set(coordinates, entries = new Map());
    entries.set(position, override);
    this.overrides.set(position, override);
    if (y>=256) {
      if (key==='air') this.upperOverrides.delete(position);
      else this.upperOverrides.set(position,override);
      this.upperRevision++;
    }
    return true;
  }

  editsInChunk(cx, cz) {
    return this.overridesByChunk.get(chunkKey(cx, cz))?.values() ?? [];
  }

  removeChunks(chunks) {
    const removed = new Set(chunks.map(({x, z}) => chunkKey(x, z)));
    if (!removed.size) return;
    for (const key of removed) this.chunks.delete(key);
    for (const key of this.blockLightOverrides.keys()) {
      const [x, , z] = key.split(',').map(Number);
      if (removed.has(chunkKey(x >> 4, z >> 4))) this.blockLightOverrides.delete(key);
    }
    for (const key of this.skyLightOverrides.keys()) {
      const [x, , z] = key.split(',').map(Number);
      if (removed.has(chunkKey(x>>4,z>>4))) this.skyLightOverrides.delete(key);
    }
  }

  hasChunk(x, z, y = 256) {
    const chunk = this.chunks.get(chunkKey(Math.floor(x / 16), Math.floor(z / 16)));
    return Boolean(chunk && !chunk.visualOnly && (!chunk.highOnly || y>=256));
  }

  section(x, y, z) {
    return this.chunks.get(chunkKey(Math.floor(x / 16), Math.floor(z / 16)))?.sections.get(Math.floor(y / 16));
  }

  cellAt(x, y, z) {
    const chunk = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!chunk || chunk.visualOnly || chunk.highOnly && y<256) return null;
    const {key, object, parts, voxels, fluid} = this.lightCell(x, y, z, false, chunk);
    if (key === 'air') return null;
    if (voxels) return {key, voxels, ...(parts && {parts}), ...(fluid && {fluid})};
    const composition = (chunk.compositions ?? this.manifest.compositions)?.[key];
    if (!composition && !object && !parts && !fluid) return key;
    return {key, ...composition, object, ...(parts && {parts}), ...(fluid && {fluid})};
  }

  revisionAt(x, y, z) {
    return this.overrides.get(cellKey(x, y, z))?.revision || 0;
  }

  lightAt(x, y, z) {
    const original = this.baseLightAt(x, y, z);
    if (!this.blockLightOverrides.size && !this.skyLightOverrides.size) return original;
    const key=cellKey(x,y,z);
    const block=this.blockLightOverrides.get(key) ?? (original&15);
    const sky=this.skyLightOverrides.get(key) ?? (original>>4);
    return sky<<4 | block;
  }

  baseLightAt(x, y, z) {
    return packedLight(this.section(x, y, z), blockIndex(x, y, z));
  }

  lightCell(x, y, z, base = false, chunk = this.chunks.get(chunkKey(x >> 4, z >> 4))) {
    const override = !base && this.overrides.size ? this.overrides.get(cellKey(x, y, z)) : null;
    if (override) return {key: this.palette[override.index], object: override.object, parts: override.parts,
      voxels: override.voxels, ...(override.fluid && {fluid: override.fluid})};
    const local = blockIndex(x, y, z);
    const index = chunk?.sections.get(y >> 4)?.indices[local] ?? 0;
    return {key: (chunk?.palette ?? this.palette)[index], object: chunk?.objects.get(y >> 4)?.get(local)};
  }

  updateLighting(chunk) {
    if (chunk) {
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const coordinates = chunkKey(chunk.x + dx, chunk.z + dz);
        const loaded=this.chunks.get(coordinates);
        if (!loaded) continue;
        for (const [position, {x, y, z}] of this.overridesByChunk.get(coordinates) ?? []) {
          if (lightChanged(this.lightCell(x, y, z, true), this.lightCell(x, y, z))) {
            this.pendingLights.set(position, [x, y, z, this.lightAt(x, y, z) & 15]);
          }
          if (loaded.hasSky && !loaded.visualOnly &&
              skyCellProfile(this,x,y,z,true,loaded) !== skyCellProfile(this,x,y,z,false,loaded)) this.pendingSky.set(position,[x,y,z]);
        }
      }
    }
    const dirty = new Set();
    for (const changed of this.pendingLights.values()) for (const section of updateBlockLight(this, ...changed)) dirty.add(section);
    this.pendingLights.clear();
    const skyGroups=new Map();
    for (const change of this.pendingSky.values()) {
      const [x,y,z]=change, key=sectionKey(x>>4,y>>4,z>>4);
      let group=skyGroups.get(key);
      if (!group) skyGroups.set(key,group=[]);
      group.push(change);
    }
    for (const group of skyGroups.values()) for (const section of updateSkyAccess(this,group)) dirty.add(section);
    this.pendingSky.clear();
    return dirty;
  }

  halo(cx, cy, cz) {
    // A local halo can reference at most 5832 distinct cells. Remap only the
    // keys it touches, and let chunk palettes and covers leave with the data.
    const compact = this.manifest.chunkPalettes;
    const palette = compact ? ['air'] : null;
    const compositions = compact ? Object.create(null) : null;
    const addresses = compact ? new Map([['air', 0]]) : null;
    const packedIndex = (key, definition) => {
      let index = addresses.get(key);
      if (index === undefined) {
        index = palette.length;
        palette.push(key);
        addresses.set(key, index);
      }
      if (definition && !compositions[key]) compositions[key] = definition;
      return index;
    };
    const indices = new Uint16Array(18 ** 3);
    const light = new Uint8Array(indices.length);
    const objects = [];
    const microblocks = [];
    const sculpted = [];
    const logged = [];
    const chunks = [-1, 0, 1].map(dz => [-1, 0, 1].map(dx => this.chunks.get(chunkKey(cx + dx, cz + dz))));
    const mappings = compact && chunks.map(row => row.map(chunk => {
      if (!chunk) return null;
      const names = chunk.palette ?? this.palette;
      const indices = new Uint16Array(names.length);
      return {names, indices, definitions:chunk.compositions};
    }));
    const overrides = this.overrides;
    const blockOverrides = this.blockLightOverrides;
    const skyOverrides = this.skyLightOverrides;
    let i = 0;
    for (let dy = -1; dy <= 16; dy++) {
      const y = cy * 16 + dy;
      for (let dz = -1; dz <= 16; dz++) {
        const z = cz * 16 + dz;
        const row = chunks[(dz >> 4) + 1];
        const mapRow = compact && mappings[(dz >> 4) + 1];
        const ySection = y >> 4;
        const localRow = blockIndex(0, y, z);
        for (let segment = 0; segment < 3; segment++) {
          const chunk = row[segment];
          const mapping = compact && mapRow[segment];
          const section = chunk?.sections.get(ySection);
          const layer = chunk?.objects.get(ySection);
          const from = segment === 0 ? -1 : segment === 1 ? 0 : 16;
          const to = segment === 0 ? 0 : segment === 1 ? 16 : 17;
          for (let dx = from; dx < to; dx++, i++) {
            const key = overrides.size || blockOverrides.size || skyOverrides.size ? cellKey(cx * 16 + dx, y, z) : null;
            const override = key && overrides.get(key);
            const index = localRow + (dx & 15);
            const baseIndex = section?.indices[index] ?? 0;
            if (compact && override) {
              const material = this.palette[override.index];
              indices[i] = packedIndex(material, mapping?.definitions?.[material]);
            } else if (compact && baseIndex) {
              let mapped = mapping.indices[baseIndex];
              if (!mapped) {
                const material = mapping.names[baseIndex];
                mapped = packedIndex(material, mapping.definitions?.[material]);
                mapping.indices[baseIndex] = mapped;
              }
              indices[i] = mapped;
            } else {
              indices[i] = override?.index ?? baseIndex;
            }
            const original = packedLight(section, index);
            const block = key ? blockOverrides.get(key) : undefined;
            const sky = key ? skyOverrides.get(key) : undefined;
            light[i]=(sky ?? (original>>4))<<4 | (block ?? (original&15));
            const object = override ? override.object : layer?.get(index);
            if (object && indices[i]) objects.push([i, object]);
            if (override?.parts && indices[i]) microblocks.push([i, override.parts]);
            if (override?.voxels && indices[i]) sculpted.push([i, override.voxels]);
            if (override?.fluid && indices[i]) logged.push([i, override.fluid]);
          }
        }
      }
    }
    return {indices, light, objects, microblocks, sculpted, ...(logged.length && {logged}), ...(compact && {palette, compositions})};
  }
}

function packedLight(section, index) {
  const shift = (index & 1) * 4;
  const sky = section?.sky ? (section.sky[index >> 1] >> shift) & 15 : 15;
  const block = section?.block ? (section.block[index >> 1] >> shift) & 15 : 0;
  return (sky << 4) | block;
}
