import {createHash} from 'node:crypto';
import {constants,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {join,relative,sep} from 'node:path';
import {pipeline} from 'node:stream/promises';

export const soloDistributionManifest='solo-download.json';
export const soloWorldSidecar=sha256=>'solo-world.'+sha256+'.json.gz';
const filesPrefix='/solo-download/files/';
const maxFileBodies=4;
const hashPattern=/^[a-f0-9]{64}$/;
const regionPattern=/^(?:0|-?[1-9]\d{0,6})\.(?:0|-?[1-9]\d{0,6})$/;
const pathSegment=/^(?!\.{1,2}$)[\p{L}\p{N} ._()-]+$/u;
const reservedName=/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

const fixedFiles = new Set([
  'world/world.json', 'world/snow-cleanup.json',
  'world/terrain-8.json', 'world/terrain-16.json', 'world/terrain-32.json',
  'full-world/manifest.json', 'lod/manifest.json', 'vista/manifest.json',
  'weather/biomes.bin', 'creative/catalog.json', 'sounds/sounds.json',
  'textures/atlas.json', 'textures/atlas.png', 'textures/boat.png',
  'textures/legacy-interface.png', 'textures/minecart.png',
  'textures/paintings.png', 'textures/pony-armor.png',
  'npcs/models.json', 'npcs/original.json',
]);

export function isSoloDistributionAsset(path) {
  if (typeof path!=='string' || path.length>700) return false;
  const segments=path.split('/');
  if (!segments.every(segment=>segment.length<=150 && pathSegment.test(segment) &&
      !/[. ]$/.test(segment) && !reservedName.test(segment))) return false;
  if (fixedFiles.has(path)) return true;
  const [family,name]=segments;
  if (segments.length===2) {
    if (['full-world','lod','vista'].includes(family) && name.endsWith('.bin')) {
      const key=name.slice(0,-4);
      return regionPattern.test(family==='lod' && key.endsWith('.outer') ? key.slice(0,-6) : key);
    }
    if (family==='models') return /^(?:biblio|jammy|redpower)\.(?:json|png)$/.test(name);
    if (family==='sounds') return /^[a-f0-9]{24}\.(?:ogg|wav)$/.test(name);
    if (family==='npcs') return /^[a-zA-Z0-9]+\.json$/.test(name);
  }
  if (family!=='npcs') return false;
  if (name==='sound') return segments.length===3 && /\.ogg$/i.test(segments[2]);
  return name==='skins' && segments.length>=3 && segments.length<=10 && /\.png$/i.test(segments.at(-1));
}

export function soloDistributionVersion({files}) {
  const sorted=Object.keys(files).sort().map(path=>[path,files[path].sha256,files[path].size]);
  return createHash('sha256').update(JSON.stringify([1,sorted])).digest('hex');
}

function validateManifest(manifest) {
  const {schema,build,version,files,initial}=manifest ?? {};
  if (schema!==1 || !Number.isSafeInteger(build) || build<1 || !hashPattern.test(version) ||
      !files || typeof files!=='object' || Array.isArray(files) || !Array.isArray(initial) ||
      !initial.length || new Set(initial).size!==initial.length) {
    throw new Error('Invalid solo distribution manifest');
  }
  const lowerPaths=new Set();
  for (const [path,asset] of Object.entries(files)) {
    if (!isSoloDistributionAsset(path) || lowerPaths.has(path.toLowerCase()) || !asset ||
        !hashPattern.test(asset.sha256) || !Number.isSafeInteger(asset.size) ||
        asset.size<1 || asset.size>1024*1024*1024) {
      throw new Error('Invalid solo distribution asset');
    }
    lowerPaths.add(path.toLowerCase());
  }
  if (initial.some(path=>typeof path!=='string' || !Object.hasOwn(files,path)) ||
      soloDistributionVersion(manifest)!==version) throw new Error('Invalid solo distribution version');
}

function decodeAsset(path) {
  try {
    const segments=path.split('/').map(decodeURIComponent);
    if (segments.some(segment=>/[\\/]/.test(segment))) return null;
    return segments.join('/');
  } catch { return null; }
}

function samePath(left,right) {
  return process.platform==='win32' ? left.toLowerCase()===right.toLowerCase() : left===right;
}

async function openContained(root,segments) {
  const resolved=await realpath(join(root,...segments));
  if (!samePath(relative(root,resolved),segments.join(sep))) return null;
  return open(resolved,constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
}

function acceptsGzip(header) {
  return (header ?? '').split(',').some(entry=>{
    const [encoding,...params]=entry.trim().toLowerCase().split(';');
    if (encoding.trim()!=='gzip') return false;
    const quality=params.find(param=>/^\s*q\s*=/.test(param));
    return !quality || Number(quality.split('=')[1])>0;
  });
}

export function loadSoloDistribution(generated) {
  const path=join(generated,soloDistributionManifest);
  const info=lstatSync(path,{throwIfNoEntry:false});
  if (!info) return null;
  if (!info.isFile() || info.size>16*1024*1024) throw new Error('Invalid solo distribution index file');
  const manifest=JSON.parse(readFileSync(path,'utf8'));
  validateManifest(manifest);
  const body=Buffer.from(JSON.stringify(manifest)+'\n');
  const root=realpathSync(generated);
  const prefix=filesPrefix+manifest.version+'/';
  let activeBodies=0;

  async function serve(request,response,pathname) {
    const head=request.method==='HEAD';
    if (!head && request.method!=='GET') return false;
    if (pathname==='/solo-download/manifest.json') {
      response.writeHead(200,{'Content-Type':'application/json; charset=utf-8',
        'Content-Length':body.length,'Cache-Control':'no-cache'});
      response.end(head ? undefined : body);
      return true;
    }
    if (!pathname.startsWith(prefix)) return false;
    const name=decodeAsset(pathname.slice(prefix.length));
    if (name===null || !Object.hasOwn(manifest.files,name)) return false;
    const file=manifest.files[name];
    const segments=name.split('/');
    let handle,encoded;
    let bodySlot=false;
    try {
      handle=await openContained(root,segments);
      if (!handle) return false;
      const stat=await handle.stat();
      if (!stat.isFile() || stat.size!==file.size) return false;
      if (!head) {
        if (activeBodies>=maxFileBodies) {
          response.writeHead(503,{'Retry-After':'2','Cache-Control':'no-store'});
          response.end();
          return true;
        }
        activeBodies++;
        bodySlot=true;
      }
      const world=name==='world/world.json';
      let size=file.size;
      let representation=handle;
      if (world && acceptsGzip(request.headers?.['accept-encoding'])) {
        encoded=await openContained(root,[soloWorldSidecar(file.sha256)]).catch(error=>{
          if (['ENOENT','ENOTDIR','EISDIR','ELOOP'].includes(error.code)) return null;
          throw error;
        });
        const compressed=await encoded?.stat();
        if (compressed?.isFile() && compressed.size>0 && compressed.size<size) {
          representation=encoded;
          size=compressed.size;
        }
      }
      const gzip=representation!==handle;
      response.writeHead(200,{'Content-Type':'application/octet-stream',
        'Content-Length':size,'Cache-Control':'public, max-age=31536000, immutable',
        ETag:'"'+file.sha256+(gzip?'-gzip':'')+'"',
        ...(world && {Vary:'Accept-Encoding'}),...(gzip && {'Content-Encoding':'gzip'})});
      if (head) response.end();
      else await pipeline(representation.createReadStream({autoClose:false}),response);
      return true;
    } catch (error) {
      if (['ENOENT','ENOTDIR','EISDIR','ELOOP'].includes(error.code) && !response.headersSent) return false;
      throw error;
    } finally {
      if (bodySlot) activeBodies--;
      await Promise.all([encoded?.close(),handle?.close()]);
    }
  }

  return {serve};
}
