import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {gzipSync} from 'node:zlib';
import {buildRegion,makeMaterials,sampleChunk,TILE_CHUNKS} from './lod-mesh.mjs';

const DEFAULT_WORLD = fileURLToPath(new URL('../generated/world',import.meta.url));
const DEFAULT_OUTPUT = fileURLToPath(new URL('../generated/lod',import.meta.url));

function inside(path,root) {
  const difference = relative(root,path);
  return !isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`);
}

function checkOutput(path) {
  if (!existsSync(path)) return;
  const names = readdirSync(path);
  if (!names.includes('manifest.json') || !names.every(name => name==='manifest.json' || /^-?\d+\.-?\d+\.bin(?:\.gz)?$/.test(name))) {
    throw new Error(`Output directory contains unrelated files: ${path}`);
  }
}

export function buildLod(worldDir = DEFAULT_WORLD, outputDir = DEFAULT_OUTPUT, progress = () => {}) {
  const world = realpathSync(resolve(worldDir));
  const destination = resolve(outputDir);
  if (inside(world,destination) || inside(destination,world)) throw new Error('Use independent world and LOD directories');
  mkdirSync(dirname(destination),{recursive:true});
  const parent = realpathSync(dirname(destination));
  const out = join(parent,basename(destination));
  if (inside(world,out) || inside(out,world) || existsSync(out) && realpathSync(out)!==out) {
    throw new Error('LOD output cannot resolve into the world or through a symbolic link');
  }
  checkOutput(out);
  const manifest = JSON.parse(readFileSync(join(world,'world.json'),'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.chunks) || !/^[a-f0-9]{64}$/.test(manifest.contentHash ?? '')) {
    throw new Error('Expected a converted Honeymoon world');
  }
  const {bounds, contentHash} = manifest;
  const minX = Math.floor(bounds.minX/16), maxX = Math.floor(bounds.maxX/16);
  const minZ = Math.floor(bounds.minZ/16), maxZ = Math.floor(bounds.maxZ/16);
  const worldChunks = new Set(manifest.chunks.map(([x,z]) => `${x}.${z}`));
  const regions = [];
  const seen = new Set();
  for (const [x,z] of manifest.chunks) {
    const rx = Math.floor(x/TILE_CHUNKS), rz = Math.floor(z/TILE_CHUNKS);
    const key = `${rx}.${rz}`;
    if (seen.has(key)) continue;
    seen.add(key);
    regions.push([rx,rz]);
  }
  regions.sort((a,b) => a[1]-b[1] || a[0]-b[0]);

  const staging = mkdtempSync(join(parent,'.honeymoon-lod-'));
  const data = join(staging,'data');
  const previous = join(staging,'previous');
  mkdirSync(data);
  let retainPrevious = false;
  const catalog = makeMaterials();
  const sampled = new Map();
  function load(x,z) {
    const key = `${x}.${z}`;
    if (!worldChunks.has(key)) return null;
    if (!sampled.has(key)) {
      const chunk = JSON.parse(readFileSync(join(world,'chunks',`${key}.json`),'utf8'));
      if (chunk.x!==x || chunk.z!==z) throw new Error(`Unexpected coordinates in chunk ${key}`);
      sampled.set(key,{z,chunk:sampleChunk({ ...chunk, palette:chunk.palette ?? manifest.palette,
        compositions:chunk.compositions ?? manifest.compositions },catalog)});
    }
    return sampled.get(key).chunk;
  }

  let quadCount = 0, bytes = 0, compressedBytes = 0, done = 0;
  const hash = createHash('sha256');
  hash.update(`HLOD:1:${TILE_CHUNKS}:24:${contentHash}\n`);
  try {
    let row;
    for (const [x,z] of regions) {
      if (z !== row) {
        row = z;
        for (const [key, entry] of sampled) if (entry.z<z*TILE_CHUNKS-1) sampled.delete(key);
      }
      const {content,quads} = buildRegion(x,z,load,catalog,minX,maxX,minZ,maxZ);
      const name = `${x}.${z}.bin`;
      const compressed = gzipSync(content,{level:3});
      writeFileSync(join(data,name),content);
      writeFileSync(join(data,name+'.gz'),compressed);
      hash.update(`${name}:${content.length}\n`);
      hash.update(content);
      quadCount += quads;
      bytes += content.length;
      compressedBytes += compressed.length;
      if (++done%64===0) progress({done,total:regions.length,quadCount,bytes,compressedBytes});
    }
    const metadata = {schemaVersion:1,contentHash,assetHash:hash.digest('hex'),maxDistance:24,tileChunks:TILE_CHUNKS,
      regions,quadCount,bytes,compressedBytes};
    writeFileSync(join(data,'manifest.json'),JSON.stringify(metadata)+'\n');
    if (existsSync(out)) {
      checkOutput(out);
      renameSync(out,previous);
      retainPrevious = true;
    }
    try {
      renameSync(data,out);
    } catch (error) {
      if (retainPrevious && !existsSync(out)) {
        renameSync(previous,out);
        retainPrevious = false;
      }
      throw error;
    }
    retainPrevious = false;
    return metadata;
  } finally {
    // staging was created as a direct child of this resolved output parent.
    if (!retainPrevious && dirname(staging)===parent && basename(staging).startsWith('.honeymoon-lod-')) {
      rmSync(staging,{recursive:true,force:true});
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const {values} = parseArgs({options:{world:{type:'string'},out:{type:'string'}}});
  const start = performance.now();
  const {regions,...result} = buildLod(values.world,values.out,status => console.log(JSON.stringify(status)));
  console.log(JSON.stringify({...result,regions:regions.length,seconds:Math.round((performance.now()-start)/100)/10}));
}
