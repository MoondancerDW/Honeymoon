import {shapeFor, FACES} from '../world/geometry.mjs';
import {fullCoverMaterial} from '../world/cover-plane.mjs';
import {FACE_SHADE} from '../client/lighting.mjs';
import {LOD_VERSION, TRANSITION_FACE, WATER_HEIGHT_SCALE} from '../client/far-tile-format.mjs';
import {lampCoverOverrides} from './lod-lamps.mjs';

export const TILE_CHUNKS = 4;
export const STEP = 2;
export const OUTER_STEP = 4;
export const CHUNK_SIDE = 16 / STEP;
const RECORD_BYTES = 16;
const AXES = [[2,1], [1,2], [0,2], [2,0], [1,0], [0,1]];
const CHILD_AXIS = [1,4,2];
const NATURAL = 0, CONSTRUCTION = 1, LEAVES = 2, LIQUID = 3;
const natural = new Set([1,2,3,4,7,12,13,14,15,16,17,19,21,24,48,56,60,73,74,78,79,80,81,82,86,87,88,99,100,103,110,121,129,160,161,162,242,244,245,2163,2165,2166,2170,2172,2173,2174,2176,2179,2180,2181]);
const leaves = new Set([18,106,243,2164,2171,2182,2183,3250]);
const tiny = new Set([6,27,28,30,31,32,37,38,39,40,50,51,55,59,63,65,66,68,69,70,72,75,76,77,83,93,94,104,105,111,115,127,131,132,140,141,142,143,147,148,2160,2168,2178]);

function faceStyle(shape, face, fluid, daylight, useFallback) {
  let tile = shape.faces[face];
  if (tile < 0 && useFallback) tile = shape.faces.find(value => value >= 0);
  if (!Number.isInteger(tile) || tile < 0) return null;
  const base = shape.tintFaces?.[face] ?? shape.tint ?? 0xffffff;
  const shade = shape.emissive ? 1 : FACE_SHADE[face];
  const rgb = [base >> 16 & 255, base >> 8 & 255, base & 255].map(channel => Math.round(channel * shade));
  return [tile, shape.emissive ? 256 : daylight, fluid ? face | 128 : face, ...rgb];
}

export function makeMaterials() {
  const byKey = new Map([['air', 0]]);
  const byComposition = new Map();
  const byStyle = new Map();
  const materials = [null];
  const styles = [null];

  function styleFor(shape, face, fluid, daylight, useFallback = false) {
    const style = faceStyle(shape, face, fluid, daylight, useFallback);
    if (!style) return 0;
    const key = style.join(',');
    if (!byStyle.has(key)) {
      byStyle.set(key, styles.length);
      styles.push(style);
    }
    return byStyle.get(key);
  }

  function materialFor(key, data) {
    if (key === 'legacy:750:0') return 0;
    const cacheKey = data ? `${key}:${data.color ?? data.Color ?? 0}:${(data.ps ?? 0) & 3}` : key;
    if (byKey.has(cacheKey)) return byKey.get(cacheKey);
    const id = Number(key.split(':')[1]);
    const cover = key.startsWith('cover-material:');
    const fluid = !cover && (id === 8 || id === 9);
    const kind = cover ? CONSTRUCTION : fluid ? LIQUID : leaves.has(id) ? LEAVES : natural.has(id) ? NATURAL : CONSTRUCTION;
    const boxes = !cover && tiny.has(id) ? [] : shapeFor(data ? {key,data} : key);
    let shape, largest = 0;
    for (const box of boxes) {
      const volume = (box.x1-box.x0) * (box.y1-box.y0) * (box.z1-box.z0);
      if (box.kind || (!box.solid && !fluid && !box.emissive) ||
          volume < (box.emissive ? .004 : .03125) || shape && (shape.emissive && !box.emissive ||
          Boolean(shape.emissive) === Boolean(box.emissive) && volume <= largest)) continue;
      largest = volume;
      shape = box;
    }
    if (!shape || shape.approximation === 'Unknown legacy block definition') {
      byKey.set(cacheKey, 0);
      return 0;
    }
    const slot = materials.length;
    byKey.set(cacheKey, slot);
    const glass = shape.mode === 'cutout' && shape.faces.every(tile => tile === 49);
    materials.push({kind, glass, sides:FACES.map((_,face) => styleFor(shape,face,fluid,240,true)), shape});
    return slot;
  }

  function get(key, compositions) {
    if (!key.startsWith('cover:')) return key.startsWith('cover-material:') ? 0 : materialFor(key);
    if (!byComposition.has(key)) {
      const [, id, meta] = key.split(':', 3);
      const cover = fullCoverMaterial(compositions?.[key]?.parts, id === '765');
      byComposition.set(key, materialFor(cover === undefined ? `legacy:${id}:${meta}` : `cover-material:${cover}`));
    }
    return byComposition.get(key);
  }

  return {get,materialFor,materials,styles,styleFor};
}

function sectionData(section) {
  const bytes = Buffer.from(section.indices, 'base64');
  return {
    indices: new Uint16Array(bytes.buffer,bytes.byteOffset,bytes.length / 2),
    sky: section.skyLight && Buffer.from(section.skyLight, 'base64'),
    block: section.blockLight && Buffer.from(section.blockLight, 'base64'),
  };
}

function lightAt(section, index) {
  if (!section) return 240;
  const shift = (index & 1) * 4;
  return (((section.sky ? section.sky[index >> 1] >> shift : 15) & 15) << 4) |
    ((section.block ? section.block[index >> 1] >> shift : 0) & 15);
}

function brightest(left, right) {
  return Math.max(left & 240, right & 240) | Math.max(left & 15, right & 15);
}

const quantizeLight = light => (light & 240) | Math.min(15, Math.round((light & 15) / 3) * 3);

function shapedLights(chunk, sections, catalog) {
  const lamps = new Map();
  for (const object of chunk.objects ?? []) {
    const [x,y,z] = object.position;
    const index = (x & 15) + (z & 15) * 16 + (y & 15) * 256;
    const key = chunk.palette[sections.get(y >> 4)?.indices[index]];
    if (key?.startsWith('legacy:768:')) lamps.set((y >> 4) * 4096 + index, catalog.materialFor(key,object.data));
  }
  return lamps;
}

export function sampleChunk(chunk, catalog, neighbors) {
  const entries = chunk.palette.map(key => catalog.get(key, chunk.compositions));
  const samplePlane = CHUNK_SIDE ** 2;
  const grid = new Uint16Array(samplePlane * 128);
  const occupancy = new Uint8Array(samplePlane * 128);
  const packedLight = new Uint8Array(samplePlane * 129).fill(240);
  let tops, waterLight;
  let highest = 0;
  const kind = catalog.materials;
  const choices = new Uint16Array(8);
  const counts = new Uint8Array(8);
  const upper = new Uint8Array(8);
  const sections = new Map(chunk.sections.map(section => [section.y, sectionData(section)]));
  const lamps = shapedLights(chunk, sections, catalog);
  for (const [index, key] of lampCoverOverrides(chunk, neighbors)) {
    lamps.set(index, key === 'air' ? 0 : catalog.materialFor(key));
  }
  const water = new Map();
  const details = new Map();

  for (const [sectionY, section] of sections) {
    const source = section.indices;
    for (let y=0; y<8; y++) for (let z=0; z<CHUNK_SIDE; z++) for (let x=0; x<CHUNK_SIDE; x++) {
      const at = x * 2 + z * 32 + y * 512;
      const cy = sectionY * 8 + y;
      let distinct = 0, occupied = 0, architecture = 0, leaf = 0, wet = 0, fluidLight = 0, light = 0;
      const index = x+CHUNK_SIDE*z+samplePlane*cy;
      for (let dy=0; dy<2; dy++) for (let dz=0; dz<2; dz++) for (let dx=0; dx<2; dx++) {
        const raw = at+dx+dz*16+dy*256;
        const savedLight = lightAt(section,raw);
        light = brightest(light,savedLight);
        const value = lamps.get(sectionY * 4096 + raw) ?? entries[source[raw]];
        if (!value) continue;
        const {kind:material,shape} = kind[value];
        occupied++;
        if (material === CONSTRUCTION) architecture++;
        if (material === LEAVES) leaf++;
        if (material === LIQUID) {
          wet++;
          const localLight = savedLight;
          fluidLight = Math.max(fluidLight,localLight);
          const next = raw >= 3840 ? sections.get(sectionY + 1) : section;
          const above = (raw + 256) & 4095;
          const neighbor = kind[entries[next?.indices[above]]];
          if (neighbor?.kind !== LIQUID && neighbor?.shape.y0 !== 0) {
            const fullHeight = shape.y1 === 1;
            const packed = fullHeight ? lightAt(next,above) : localLight;
            const surfaceY = (cy * 2 + dy) * WATER_HEIGHT_SCALE + Math.round(shape.y1 * WATER_HEIGHT_SCALE);
            const style = catalog.styleFor(shape,3,true,packed);
            const key = surfaceY * 65536 + style;
            if (!water.has(key)) water.set(key,{surfaceY,style,cells:[]});
            water.get(key).cells.push(x * 2 + dx + (z * 2 + dz) * 16);
          }
        }
        let slot = 0;
        while (slot < distinct && choices[slot] !== value) slot++;
        if (slot === distinct) {
          choices[distinct] = value;
          upper[distinct] = 0;
          counts[distinct++] = 0;
        }
        counts[slot]++;
        upper[slot] += dy;
      }
      packedLight[index] = quantizeLight(light);
      if (occupied < 4 && architecture < 1 && leaf < 2) continue;
      let selected = 0, score = -1;
      const glazed = choices.subarray(0,distinct).some(value => kind[value].glass);
      const exteriorBuild = architecture > 0 && occupied < 8;
      for (let slot=0; slot<distinct; slot++) {
        const id = choices[slot];
        const priority = kind[id].kind === CONSTRUCTION && exteriorBuild ? 4 : 0;
        const rank = counts[slot] + priority + (glazed && kind[id].shape.emissive ? 8 : 0);
        if (rank > score || rank === score && id < selected) {
          score = rank;
          selected = id;
        }
      }
      grid[index] = selected;
      if (wet > 0 ? wet < occupied : architecture > 0 && occupied < 8) {
        const cubes = new Uint16Array(8);
        for (let dy=0; dy<2; dy++) for (let dz=0; dz<2; dz++) for (let dx=0; dx<2; dx++) {
          const raw = at+dx+dz*16+dy*256;
          const material = lamps.get(sectionY * 4096 + raw) ?? entries[source[raw]];
          if (material && kind[material].kind !== LIQUID) cubes[dx+dz*2+dy*4] = material;
        }
        details.set(index,cubes);
      }
      // Preserve the exposed material of grass, thin snow and roof courses
      // when the lower cells would otherwise determine the entire cube.
      if (distinct > 1) {
        let top = selected, topCount = 0;
        for (let slot=0; slot<distinct; slot++) {
          const material = choices[slot];
          if (kind[material].kind !== kind[selected].kind || upper[slot] <= topCount) continue;
          top = material;
          topCount = upper[slot];
        }
        if (top !== selected) {
          tops ??= new Uint16Array(samplePlane * 128);
          tops[index] = top;
        }
      }
      occupancy[index] = occupied;
      if (wet > 0) {
        waterLight ??= new Uint8Array(samplePlane * 128).fill(240);
        waterLight[index] = fluidLight;
      }
      highest = Math.max(highest,cy+1);
    }
  }

  // Smooth flat, natural blocks to 4-block horizontal cells. Keep the 2-block
  // samples where coarse cells meet structures, water, leaf crowns or steep land.
  for (let y=0; y<highest; y++) for (let z=0; z<CHUNK_SIDE; z+=2) for (let x=0; x<CHUNK_SIDE; x+=2) {
    const index = x + CHUNK_SIDE*z + samplePlane*y;
    const a=grid[index], b=grid[index+1], c=grid[index+CHUNK_SIDE], d=grid[index+CHUNK_SIDE+1];
    if (!a || !b || !c || !d || kind[a].kind !== NATURAL || kind[b].kind !== NATURAL ||
      kind[c].kind !== NATURAL || kind[d].kind !== NATURAL) continue;
    if (a === b && a === c && a === d) continue;
    let selected = a, max = occupancy[index];
    if (occupancy[index+1] > max) { selected=b; max=occupancy[index+1]; }
    if (occupancy[index+CHUNK_SIDE] > max) { selected=c; max=occupancy[index+CHUNK_SIDE]; }
    if (occupancy[index+CHUNK_SIDE+1] > max) selected=d;
    grid[index]=grid[index+1]=grid[index+CHUNK_SIDE]=grid[index+CHUNK_SIDE+1]=selected;
  }

  return {grid:grid.slice(0,highest*samplePlane), tops:tops?.slice(0,highest*samplePlane), highest,
    details, water:[...water.values()], waterLight:waterLight?.slice(0,highest*samplePlane),
    light:packedLight.slice(0,(highest+1)*samplePlane)};
}

export function outerChunk(chunk) {
  const side = 16 / OUTER_STEP, plane = side ** 2, innerPlane = CHUNK_SIDE ** 2;
  const highest = Math.ceil(chunk.highest / 2);
  const grid = new Uint16Array(plane * highest), light = new Uint8Array(plane * (highest + 1)).fill(240);
  const variants = new Uint16Array(8), scores = new Uint8Array(8);
  for (let y=0; y<=highest; y++) for (let z=0; z<side; z++) for (let x=0; x<side; x++) {
    let packed = 0, used = 0, occupied = 0;
    for (let dy=0; dy<2; dy++) for (let dz=0; dz<2; dz++) for (let dx=0; dx<2; dx++) {
      const source = (y * 2 + dy) * innerPlane + (z * 2 + dz) * CHUNK_SIDE + x * 2 + dx;
      packed = brightest(packed, chunk.light[source] ?? 240);
      const value = chunk.tops?.[source] || chunk.grid[source];
      if (!value) continue;
      occupied++;
      let index = 0;
      while (index < used && variants[index] !== value) index++;
      if (index === used) { variants[used] = value; scores[used++] = 0; }
      scores[index] += 2 + dy;
    }
    const at = y * plane + z * side + x;
    light[at] = quantizeLight(packed);
    if (occupied < 2 || y === highest) continue;
    let winner = 0;
    for (let index=1; index<used; index++) if (scores[index] > scores[winner]) winner = index;
    grid[at] = variants[winner];
  }
  return {grid, light, highest, details:new Map(), water:chunk.water};
}

function floodExterior(grid, size, yCount, plane, transparent, shores) {
  const visited = new Uint8Array(grid.length);
  const queue = new Uint32Array(grid.length);
  const strides = [-1, 1, -plane, plane, -size, size];
  let read = 0, write = 0;
  for (let at=plane*(yCount-1); at<grid.length; at++) {
    if (grid[at]) continue;
    queue[write++] = at;
    visited[at] = 1;
  }
  while (read<write) {
    const at = queue[read++];
    const y = Math.floor(at / plane);
    const z = Math.floor((at - y*plane) / size);
    const x = at % size;
    for (let face=0; face<6; face++) {
      if (face===0 && x===0 || face===1 && x===size-1 || face===2 && y===0 ||
          face===3 && y===yCount-1 || face===4 && z===0 || face===5 && z===size-1) continue;
      const to = at + strides[face];
      if (visited[to] || grid[to] && !transparent[grid[to]] && !shores.has(to)) continue;
      visited[to] = 1;
      queue[write++] = to;
    }
  }
  return visited;
}

function chunkBoundary(mask, uSize, vSize, consume) {
  for (let v=0; v<vSize; v++) for (let u=0; u<uSize; u++) {
    const index = u+uSize*v;
    const value = mask[index];
    if (!value) continue;
    let width = 1, height = 1;
    while (u+width<uSize && mask[index+width]===value) width++;
    next: while (v+height<vSize) {
      const row = index+height*uSize;
      for (let i=0; i<width; i++) if (mask[row+i]!==value) break next;
      height++;
    }
    for (let row=v; row<v+height; row++) mask.fill(0,row*uSize+u,row*uSize+u+width);
    consume(u,v,width,height,value);
  }
}

function detailFaces(masks, skirt, width, start, catalog, terrain, face, at, adjacent, cutoff) {
  const {grid,light,waterLight,liquid,visited,details} = terrain;
  const {materials,styleFor} = catalog;
  const here = details.get(at), there = details.get(adjacent);
  const hereSolid = liquid[grid[at]] ? 0 : grid[at];
  const thereSolid = liquid[grid[adjacent]] ? 0 : grid[adjacent];
  const axis = face >> 1, upper = face & 1;
  const [uAxis,vAxis] = AXES[face];
  function style(cube, packed) {
    const material = materials[cube];
    return packed === 240 ? material.sides[face] : styleFor(material.shape,face,false,packed,true);
  }
  for (let v=0; v<2; v++) for (let u=0; u<2; u++) {
    const child = u*CHILD_AXIS[uAxis]+v*CHILD_AXIS[vAxis];
    const front = child+upper*CHILD_AXIS[axis];
    const back = child+(1-upper)*CHILD_AXIS[axis];
    const facing = here ? here[front] : hereSolid;
    const other = there ? there[back] : thereSolid;
    const slot = start + u + v*width;
    const packed = liquid[grid[adjacent]] ? waterLight[adjacent] : light[adjacent];
    const exposed = !other || materials[other].glass && !materials[facing]?.glass;
    if (!cutoff && visited[adjacent] && facing && exposed) masks[0][slot] = style(facing,packed);
    else if (skirt && facing) skirt[slot] = style(facing,brightest(light[at],packed));
    if (here && visited[at] && here[back] && !facing) masks[1][slot] = style(here[back],light[at]);
  }
}

function makeChunkQuads(terrain, gx, gz, chunk, catalog, boundary, sampleStep) {
  const {grid, tops, light, waterLight, visited, size, plane, liquid, transparent, details} = terrain;
  const {materials, styles, styleFor} = catalog;
  const highest = chunk.highest;
  const begin = gx+gz*size;
  const chunkSide = 16 / sampleStep;
  const limits = [chunkSide,highest,chunkSide];
  const strides = [1,plane,size];
  const records = [];
  for (let face=0; face<6; face++) {
    const axis = face>>1;
    const direction = face&1 ? 1 : -1;
    const offset = direction * strides[axis];
    const [uAxis,vAxis] = AXES[face];
    const uSize = limits[uAxis], vSize = limits[vAxis];
    const mask = new Uint32Array(uSize*vSize);
    const skirt = axis !== 1 ? new Uint32Array(uSize*vSize) : null;
    const fine = details.size ? [new Uint32Array(uSize*vSize*4),new Uint32Array(uSize*vSize*4)] : null;
    const fineSkirt = fine && skirt ? new Uint32Array(uSize*vSize*4) : null;
    const point = [0,0,0];
    const emit = (mask,step,transition = 0) => chunkBoundary(mask,uSize*sampleStep/step,vSize*sampleStep/step,(u,v,width,height,style) => {
      point[uAxis] = u*step;
      point[vAxis] = v*step;
      const [tile,light,flags,r,g,b] = styles[style];
      records.push(point[0],point[2],point[1],width*step,height*step,flags|transition,tile,light,r,g,b);
    });
    for (let slice=0; slice<limits[axis]; slice++) {
      const edge = slice===(face&1 ? limits[axis]-1 : 0);
      const cutoff = face===2 && slice===0 || boundary[face] && edge;
      if (cutoff && !fine) continue;
      point[axis] = (slice + (face&1)) * sampleStep;
      const slabOrigin = begin+slice*strides[axis];
      const transition = skirt && edge && !cutoff;
      let refined = false;
      for (let v=0; v<vSize; v++) {
        let at=slabOrigin+v*strides[vAxis];
        for (let u=0; u<uSize; u++,at+=strides[uAxis]) {
          const value=grid[at], neighbor=grid[at+offset];
          if (fine && value && (details.has(at) || !cutoff && details.has(at+offset))) {
            refined = true;
            detailFaces(fine,transition && fineSkirt,uSize*2,u*2+v*uSize*4,catalog,terrain,face,at,at+offset,cutoff);
            continue;
          }
          if (cutoff || !value || liquid[value]) continue;
          const material = materials[face === 3 && tops[at] ? tops[at] : value];
          const packed = liquid[neighbor] ? waterLight[at+offset] : light[at+offset];
          const slot = u+v*uSize;
          if (visited[at+offset] && (!neighbor || transparent[neighbor] && !material.glass)) {
            mask[slot] = packed === 240 ? material.sides[face] : styleFor(material.shape,face,false,packed,true);
          } else if (transition) {
            skirt[slot] = styleFor(material.shape,face,false,brightest(light[at],packed),true);
          }
        }
      }
      emit(mask,sampleStep);
      if (transition) emit(skirt,sampleStep,TRANSITION_FACE);
      if (refined) {
        emit(fine[0],1);
        if (transition) emit(fineSkirt,1,TRANSITION_FACE);
        point[axis] -= direction;
        emit(fine[1],1);
      }
    }
  }
  const mask = new Uint16Array(16 * 16);
  for (const {surfaceY,style,cells} of chunk.water) {
    // Keep the source surface height and outline, including one-block streams.
    // The coarse flood still excludes water deep inside sealed volumes.
    const y = Math.ceil(surfaceY / WATER_HEIGHT_SCALE) - 1;
    const waterPlane = begin + Math.floor(y / sampleStep) * plane;
    for (const cell of cells) {
      const at = waterPlane + Math.floor((cell & 15) / sampleStep) + Math.floor((cell >> 4) / sampleStep) * size;
      if (visited[at] || visited[at + plane]) mask[cell] = 1;
    }
    const [tile,light,flags,r,g,b] = styles[style];
    chunkBoundary(mask,16,16,(x,z,width,height) => {
      // The top face's U axis follows Z and its V axis follows X.
      records.push(x,z,surfaceY,height,width,flags,tile,light,r,g,b);
    });
  }
  return records;
}

export function buildRegion(rx,rz,loadChunk,catalog,minX,maxX,minZ,maxZ,sampleStep = STEP) {
  const halo = 1;
  const span = TILE_CHUNKS+halo*2;
  const chunkSide = 16 / sampleStep;
  const size = span*chunkSide;
  const plane = size*size;
  const regionX = rx*TILE_CHUNKS, regionZ = rz*TILE_CHUNKS;
  const chunks = [];
  let highest = 0;
  for (let z=-halo; z<TILE_CHUNKS+halo; z++) for (let x=-halo; x<TILE_CHUNKS+halo; x++) {
    const chunk = loadChunk(regionX+x,regionZ+z);
    chunks.push(chunk);
    highest = Math.max(highest,chunk?.highest ?? 0);
  }
  const yCount = highest+1;
  const grid = new Uint16Array(plane*yCount);
  const tops = new Uint16Array(grid.length);
  const light = new Uint8Array(grid.length).fill(240);
  const waterLight = new Uint8Array(grid.length).fill(240);
  const details = new Map();
  for (let z=0; z<span; z++) for (let x=0; x<span; x++) {
    const chunk = chunks[x+z*span];
    if (!chunk) continue;
    for (const [index,shape] of chunk.details) {
      const cy = Math.floor(index / (chunkSide ** 2));
      const cz = Math.floor(index / chunkSide) % chunkSide;
      const cx = index % chunkSide;
      details.set(cy*plane+size*(z*chunkSide+cz)+x*chunkSide+cx,shape);
    }
    for (let y=0; y<=chunk.highest; y++) for (let row=0; row<chunkSide; row++) {
      const from = (y*chunkSide+row)*chunkSide;
      const to = y*plane+size*(z*chunkSide+row)+x*chunkSide;
      grid.set(chunk.grid.subarray(from,from+chunkSide),to);
      light.set(chunk.light.subarray(from,from+chunkSide),to);
      if (chunk.tops) tops.set(chunk.tops.subarray(from,from+chunkSide),to);
      if (chunk.waterLight) waterLight.set(chunk.waterLight.subarray(from,from+chunkSide),to);
    }
  }
  const liquid = catalog.materials.map(material => material?.kind === LIQUID);
  const transparent = catalog.materials.map((material,index) => liquid[index] || material?.glass);
  const terrain = {grid, tops, light, waterLight, size, plane, liquid, transparent, details,
    visited:floodExterior(grid,size,yCount,plane,transparent,details)};
  const records = [];
  for (let z=0; z<TILE_CHUNKS; z++) for (let x=0; x<TILE_CHUNKS; x++) {
    const cx = regionX+x, cz=regionZ+z;
    const chunk = chunks[x+halo+(z+halo)*span];
    if (!chunk) { records.push([]); continue; }
    const boundary = [cx===minX,cx===maxX,false,false,cz===minZ,cz===maxZ];
    records.push(makeChunkQuads(terrain,(x+halo)*chunkSide,(z+halo)*chunkSide,chunk,catalog,boundary,sampleStep));
  }
  const quads = records.reduce((total,record) => total+record.length/11,0);
  const headerBytes = 8 + TILE_CHUNKS ** 2 * 4;
  const content = Buffer.alloc(headerBytes+quads*RECORD_BYTES);
  content.write('HLOD',0);
  content.writeUInt16LE(LOD_VERSION,4);
  content[6] = TILE_CHUNKS;
  content[7] = RECORD_BYTES;
  let at=headerBytes;
  for (let index=0; index<records.length; index++) {
    const record = records[index];
    content.writeUInt32LE(record.length/11,8+index*4);
    for (let field=0; field<record.length; field+=11,at+=RECORD_BYTES) {
      const [x,z,y,width,height,flags,tile,light,r,g,b] = record.slice(field,field+11);
      content[at]=x;
      content[at+1]=z;
      content.writeUInt16LE(y,at+2);
      content.writeUInt16LE(width,at+4);
      content.writeUInt16LE(height,at+6);
      content[at+8]=flags;
      content.writeUInt16LE(tile,at+9);
      content.writeUInt16LE(light,at+11);
      content[at+13]=r;
      content[at+14]=g;
      content[at+15]=b;
    }
  }
  return {quads,content};
}
