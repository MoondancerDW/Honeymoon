import {createHash,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {lstat,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {join,relative,resolve,sep} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {createGzip} from 'node:zlib';
import {isSoloDistributionAsset,soloDistributionManifest,soloDistributionVersion,soloWorldSidecar} from '../server/solo-distribution.mjs';
import {FULL_DETAIL_VERSION,detailCoverage} from '../world/full-detail.mjs';
import {soloRegionFile} from '../server/solo-assets.mjs';

const defaultGenerated=fileURLToPath(new URL('../generated/',import.meta.url));
const hashPattern=/^[a-f0-9]{64}$/;
const starterRadius=2;
const requiredFiles=[
  'world/world.json', 'full-world/manifest.json', 'lod/manifest.json', 'vista/manifest.json',
  'creative/catalog.json', 'sounds/sounds.json', 'textures/atlas.json', 'textures/atlas.png',
  'textures/legacy-interface.png', 'textures/minecart.png', 'textures/paintings.png',
  'models/biblio.json','models/biblio.png','models/jammy.json','models/jammy.png',
  'models/redpower.json','models/redpower.png','npcs/models.json','npcs/original.json',
];
const optionalCommon=['world/snow-cleanup.json','textures/boat.png','textures/pony-armor.png'];

function packedRegions(descriptor,family,columns) {
  if (!Array.isArray(descriptor?.regions) || !descriptor.regions.length ||
      !descriptor.regions.every(row=>Array.isArray(row) && row.length===columns &&
        row.slice(0,2).every(value=>Number.isSafeInteger(value)&&Math.abs(value)<10_000_000))) {
    throw new Error('Invalid '+family+' regions');
  }
  const regions=descriptor.regions.map(row=>row.slice(0,2).join('.'));
  if (new Set(regions).size!==regions.length) throw new Error('Duplicate '+family+' region');
  return regions;
}

async function fileInfo(root,path,optional=false) {
  if (!isSoloDistributionAsset(path)) throw new Error('Unsafe solo asset name: '+path);
  const file=join(root,...path.split('/'));
  const info=await lstat(file).catch(error=>{
    if (optional && error.code==='ENOENT') return null;
    throw error;
  });
  if (!info) return null;
  const real=relative(root,await realpath(file));
  const expected=path.split('/').join(sep);
  const matches=process.platform==='win32' ? real.toLowerCase()===expected.toLowerCase() : real===expected;
  if (!info.isFile() || info.size<1 || info.size>1024*1024*1024 || !matches) {
    throw new Error('Invalid solo asset file: '+path);
  }
  return {file,size:info.size};
}

async function digestFile(file) {
  const hash=createHash('sha256');
  for await (const part of createReadStream(file)) hash.update(part);
  return hash.digest('hex');
}

export async function prepareSoloWorldEncoding(generated,sha256) {
  if (!hashPattern.test(sha256)) throw new Error('Invalid solo world digest');
  const destination=join(generated,soloWorldSidecar(sha256));
  const temporary=destination+'.'+randomUUID()+'.tmp';
  try {
    await pipeline(createReadStream(join(generated,'world','world.json')),createGzip({level:3}),
      createWriteStream(temporary,{flags:'wx'}));
    await rename(temporary,destination);
  } finally { await rm(temporary,{force:true}); }
}

export async function buildSoloDistribution({generated=defaultGenerated,build=4}={}) {
  if (!Number.isSafeInteger(build) || build<1) throw new Error('Invalid solo build number');
  const root=await realpath(resolve(generated));
  const files=Object.create(null);
  const lowerPaths=new Set();
  const initial=new Set();

  async function add(path,{optional=false,sha256,start=false}={}) {
    if (Object.hasOwn(files,path)) {
      if (start) initial.add(path);
      return files[path].size;
    }
    const info=await fileInfo(root,path,optional);
    if (!info) return 0;
    const lower=path.toLowerCase();
    if (lowerPaths.has(lower)) throw new Error('Conflicting solo asset name: '+path);
    lowerPaths.add(lower);
    files[path]={sha256:sha256 ?? await digestFile(info.file),size:info.size};
    if (start) initial.add(path);
    return info.size;
  }

  async function read(path) {
    const {file}=await fileInfo(root,path);
    return JSON.parse(await readFile(file,'utf8'));
  }

  const world=await read('world/world.json');
  const detail=await read('full-world/manifest.json');
  const regionKeys=packedRegions(detail,'full detail',3);
  if (world.schemaVersion!==1 || !world.chunkPalettes || !hashPattern.test(world.contentHash) ||
      !Array.isArray(world.spawn) || world.spawn.length!==3 || !world.spawn.every(Number.isFinite) ||
      detail.version!==FULL_DETAIL_VERSION || detail.sourceHash!==world.contentHash ||
      !hashPattern.test(detail.hash) || !detail.hashes || Object.keys(detail.hashes).length!==regionKeys.length ||
      !detail.regions.every(row=>typeof row[2]==='string'&&/^[A-Za-z0-9+/]{171}=$/.test(row[2]))) {
    throw new Error('Mismatched original world and full detail manifest');
  }
  const covers=detailCoverage(detail);
  const [sx,,sz]=world.spawn;
  const spawnX=Math.floor(sx/16), spawnZ=Math.floor(sz/16);
  if (!covers(spawnX,spawnZ)) throw new Error('Full-world data do not cover solo spawn');

  for (const path of requiredFiles) await add(path,{start:true});
  for (const path of optionalCommon) await add(path,{optional:true,start:true});
  for (const ring of world.terrain ?? []) await add('world/'+ring.file);
  await add('weather/biomes.bin');
  let fullBytes=0;
  for (const key of regionKeys) {
    const sha256=detail.hashes[key];
    if (!hashPattern.test(sha256)) throw new Error('Missing digest for full detail region '+key);
    fullBytes+=await add('full-world/'+key+'.bin',{sha256});
  }
  if (!Number.isSafeInteger(detail.bytes) || detail.bytes!==fullBytes) {
    throw new Error('Full-world pack sizes do not match their generated manifest');
  }

  const lod=await read('lod/manifest.json');
  const vista=await read('vista/manifest.json');
  const lodKeys=new Set(packedRegions(lod,'LOD',2));
  const vistaKeys=new Set(packedRegions(vista,'vista',2));
  if (lod.tileChunks!==4 || !hashPattern.test(lod.assetHash) || !hashPattern.test(vista.hash)) {
    throw new Error('Invalid solo terrain descriptor');
  }
  for (const key of lodKeys) {
    await add('lod/'+key+'.bin');
    if (lod.maxDistance>=32) await add('lod/'+key+'.outer.bin');
  }
  for (const key of vistaKeys) await add('vista/'+key+'.bin');
  for (let z=spawnZ-starterRadius;z<=spawnZ+starterRadius;z++) {
    for (let x=spawnX-starterRadius;x<=spawnX+starterRadius;x++) {
      if (covers(x,z)) await add(soloRegionFile(x,z),{start:true});
      const lodKey=[Math.floor(x/lod.tileChunks),Math.floor(z/lod.tileChunks)].join('.');
      if (lodKeys.has(lodKey)) await add('lod/'+lodKey+'.bin',{start:true});
      const vistaKey=[Math.floor(x/32),Math.floor(z/32)].join('.');
      if (vistaKeys.has(vistaKey)) await add('vista/'+vistaKey+'.bin',{start:true});
    }
  }

  const sounds=await read('sounds/sounds.json');
  if (!sounds.sounds || typeof sounds.sounds!=='object') throw new Error('Invalid sound index');
  for (const name of new Set(Object.values(sounds.sounds).flat())) await add('sounds/'+name);

  const npcs=await read('npcs/models.json');
  if (!Array.isArray(npcs.catalog) || !Array.isArray(npcs.textures)) throw new Error('Invalid NPC index');
  for (const model of npcs.catalog) await add('npcs/'+model.id+'.json',{optional:model.capture!=='native'});
  for (const texture of npcs.textures) {
    if (typeof texture!=='string' || !texture.startsWith('/')) throw new Error('Invalid NPC texture path');
    await add('npcs/skins'+texture);
  }
  const songNames=await readdir(join(root,'npcs','sound')).catch(error=>{
    if (error.code!=='ENOENT') throw error;
    return [];
  });
  for (const name of songNames) if (/^[\p{L}\p{N} ._()-]+\.ogg$/iu.test(name)) {
    await add('npcs/sound/'+name);
  }

  const descriptor={schema:1,build,files,initial:[...initial].sort()};
  const manifest={...descriptor,version:soloDistributionVersion(descriptor)};
  const destination=join(root,soloDistributionManifest);
  const temporary=destination+'.'+randomUUID()+'.tmp';
  try {
    await prepareSoloWorldEncoding(root,files['world/world.json'].sha256);
    await writeFile(temporary,JSON.stringify(manifest)+'\n',{flag:'wx'});
    await rename(temporary,destination);
  } finally { await rm(temporary,{force:true}); }
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const {values}=parseArgs({options:{generated:{type:'string'},build:{type:'string',default:'4'}}});
  const {build,version,files,initial}=await buildSoloDistribution({generated:values.generated,build:Number(values.build)});
  console.log(JSON.stringify({build,version,files:Object.keys(files).length,initial:initial.length,
    bytes:Object.values(files).reduce((total,file)=>total+file.size,0),
    initialBytes:initial.reduce((total,path)=>total+files[path].size,0)},null,2));
}
