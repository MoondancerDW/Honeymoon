import {createHash} from 'node:crypto';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {backupState} from './backup.mjs';
import {cellAddress,loadBase} from './base.mjs';
import {openStore} from './store.mjs';
import {pistonHead} from './pistons.mjs';
import {blockState,signalSides} from '../world/block-interactions.mjs';
import {chiselSourceVolume} from '../world/chisel-surface.mjs';
import {coverBoxes,shapeFor} from '../world/geometry.mjs';
import {isMicroblockCell,microblockAddition,microblockKey,partBoxesOverlapBox,publicMicroPart} from '../world/microblocks.mjs';
import {bedMate} from '../world/seats.mjs';
import {decodeVoxels,isChiselMaterial,voxelBox,voxelKey,writeVoxelBrush} from '../world/voxel-chisel.mjs';

const project = fileURLToPath(new URL('../',import.meta.url));
const cellKey = ({x,y,z}) => cellAddress(x,y,z);
const coordinates = ({x,y,z}) => [x,y,z];
const notAir = cell => Boolean(cell && cell !== 'air');

function baseView(base, point) {
  const original = base.getCell(...point);
  return {...original, parts:base.manifest.compositions?.[original.key]?.parts};
}

function restoreParts(current, original, storedParts, owner) {
  const owned = storedParts ?? (current.parts ?? []).map(part => ({...publicMicroPart(part),owner}));
  let parts = owned.map(publicMicroPart);
  const restored = [];
  let blocked = 0;
  for (const part of original.parts) {
    const existing = owned.find(other => other.slot === part.slot);
    if (existing) {
      if (existing.owner || existing.material !== part.material || existing.shape !== part.shape) blocked++;
      continue;
    }
    const added = microblockAddition(parts,part,current.voxels);
    if (!added) blocked++;
    else {
      parts = added.parts;
      restored.push({...publicMicroPart(part),owner:null});
    }
  }
  if (!restored.length) return {blocked,restored:0,change:null};
  const next = [...owned,...restored].sort((a,b)=>a.slot-b.slot);
  const exact = !owner && !current.voxels && !blocked && next.length === original.parts.length && next.every(part=>!part.owner);
  const change = exact
    ? {...current,cell:original.key,object:original.object,parts:undefined}
    : {...current,cell:microblockKey,object:null,parts:next};
  return {blocked,restored:restored.length,change};
}

function restoreVoxels(current, original, owner) {
  const source = chiselSourceVolume(original.key,shapeFor(original));
  const occupancy = decodeVoxels(source), installed = decodeVoxels(current.voxels);
  if (!installed) throw new Error(`Invalid saved voxel data at ${cellKey(current)}`);
  const boxes = coverBoxes(current.parts ?? []);
  const indices = [];
  let blocked = 0;
  for (let i=0;i<occupancy.length;i++) {
    if (!occupancy[i]) continue;
    if (installed[i]) {
      if (current.voxels.materials[installed[i]-1] !== source.materials[0]) blocked++;
    } else if (partBoxesOverlapBox(boxes,voxelBox(i))) blocked++;
    else indices.push(i);
  }
  if (!indices.length) return {blocked,restored:0,change:null};
  const voxels = writeVoxelBrush(current.voxels,{indices},source.materials[0]);
  const entireOriginal = !owner && !current.parts?.length && voxels.data === source.data &&
    voxels.materials.length === 1 && voxels.materials[0] === source.materials[0];
  const change = entireOriginal
    ? {...current,cell:original.key,object:original.object,voxels:undefined,parts:undefined}
    : {...current,cell:current.parts?.length ? microblockKey : voxelKey,voxels};
  return {blocked,restored:indices.length,change};
}

function companion(base, change) {
  const get = (x,y,z) => ({x,y,z,...base.getCell(x,y,z)});
  const [x,y,z] = coordinates(change);
  const source = get(x,y,z);
  const [id,meta] = blockState(source);
  if (id === 26) return bedMate(source,source,get);
  if (id === 64 || id === 71) {
    const other = get(x,y+(meta & 8 ? -1 : 1),z);
    const [nextId,nextMeta] = blockState(other);
    return nextId === id && Boolean(meta & 8) !== Boolean(nextMeta & 8) ? other : null;
  }
  if (id === 29 || id === 33) return pistonHead(source,get);
  if (id === 34) {
    const side = signalSides[meta & 7];
    if (side) {
      const stem = get(x-side[0],y-side[1],z-side[2]);
      const head = pistonHead(stem,get);
      if (head && cellKey(head) === cellKey(change)) return stem;
    }
  }
  return null;
}

// The immutable release world remains the default. The SQLite overlay only
// fills slots lost during play; occupied authored geometry is kept intact.
export function restoreOriginalEdits(base,store,{verifyChunk=()=>{},expectedRevision} = {}) {
  return store.atomic(() => {
    const revision = store.worldRevision();
    if (expectedRevision !== undefined && revision !== expectedRevision) {
      throw new Error('The save changed after its backup. Stop the server and retry.');
    }
    if (store.baseHash() !== base.hash) throw new Error('The save belongs to a different original map.');
    const planned = new Map();
    const result = {blocks:0,parts:0,voxels:0,blockedBlocks:0,blockedParts:0,blockedVoxels:0,revision};
    for (const current of store.edits()) {
      const point = coordinates(current);
      if (base.hasPlayableChunk && !base.hasPlayableChunk(point[0]>>4,point[2]>>4)) continue;
      verifyChunk(...point);
      const original = baseView(base,point);
      if (!notAir(original.key)) continue;
      const owner = store.getEditOwner(...point);
      const ownedParts = store.getMicroParts(...point);
      if (current.cell === null) {
        planned.set(cellKey(current),{original,change:{...current,cell:original.key,object:original.object,
          parts:undefined,voxels:undefined},owner:null,parts:null,kind:'blocks',count:1});
      } else if (current.fluid) {
        result.blockedBlocks += Number(current.cell !== original.key || Boolean(current.voxels));
      } else if (isMicroblockCell(original) && (isMicroblockCell({key:current.cell, parts:current.parts}) || current.cell === voxelKey)) {
        const partial = restoreParts(current,original,ownedParts,owner);
        result.blockedParts += partial.blocked;
        if (partial.change) planned.set(cellKey(current),{original,change:partial.change,owner,parts:partial.change.parts,
          kind:'parts',count:partial.restored});
      } else if (current.voxels && isChiselMaterial(original.key)) {
        const partial = restoreVoxels(current,original,owner);
        result.blockedVoxels += partial.blocked;
        if (partial.change) planned.set(cellKey(current),{original,change:partial.change,owner,parts:ownedParts,
          kind:'voxels',count:partial.restored});
      } else if (owner && current.cell !== original.key) result.blockedBlocks++;
    }
    for (const [key,entry] of planned) {
      if (entry.kind !== 'blocks') continue;
      const other = companion(base,entry.change);
      if (!other || planned.has(cellKey(other))) continue;
      const point = coordinates(other);
      const edited = store.getEdit(...point);
      if (!edited || edited.cell === base.getCell(...point).key && !store.getEditOwner(...point)) continue;
      planned.delete(key);
      result.blockedBlocks++;
    }
    if (!planned.size) return result;
    result.revision = store.nextRevision();
    for (const {change,owner,parts,kind,count} of planned.values()) {
      store.writeEdit({...change,revision:result.revision},JSON.stringify(base.getCell(...coordinates(change))),owner,parts,false);
      result[kind] += count;
    }
    return result;
  });
}

export async function restoreFromBackup(backupWorld, world, state, stateBackup) {
  if (realpathSync(backupWorld) === realpathSync(world)) throw new Error('Use the separately extracted original-map backup.');
  const live = loadBase(world);
  const original = loadBase(backupWorld);
  if (original.hash !== live.hash || !readFileSync(join(backupWorld,'world.json')).equals(readFileSync(join(world,'world.json')))) {
    throw new Error('The original-map backup does not match this build.');
  }
  const verified = new Set();
  function verifyChunk(x,_y,z) {
    const file = `${x>>4}.${z>>4}.json`;
    if (verified.has(file)) return;
    const expected = live.manifest.chunkHash?.[file];
    const data = readFileSync(join(backupWorld,'chunks',file));
    if (!expected || createHash('sha256').update(data).digest('hex') !== expected) {
      throw new Error(`Original-map backup chunk failed verification: ${file}`);
    }
    verified.add(file);
  }
  await backupState(state,stateBackup);
  const snapshot = new DatabaseSync(stateBackup,{readOnly:true});
  let expectedRevision;
  try {
    if (snapshot.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('The SQLite rollback snapshot is invalid.');
    expectedRevision = Number(snapshot.prepare("SELECT value FROM metadata WHERE key='world_revision'").get().value);
  } finally { snapshot.close(); }
  const store = openStore(state);
  try { return {stateBackup,...restoreOriginalEdits(original,store,{verifyChunk,expectedRevision})}; }
  finally { store.close(); }
}

async function main() {
  const {values} = parseArgs({options:{'backup-world':{type:'string'},world:{type:'string'},state:{type:'string'},'state-backup':{type:'string'}}});
  if (!values['backup-world']) throw new Error('Use --backup-world <original world folder> with the server stopped.');
  const state = resolve(values.state ?? process.env.HONEYMOON_STATE ?? join(project,'state','honeymoon.sqlite'));
  const world = resolve(values.world ?? join(project,'generated','world'));
  const stamp = new Date().toISOString().replace(/[:.]/g,'-');
  const stateBackup = resolve(values['state-backup'] ?? join(project,'state','backups',`before-map-restore-${stamp}.sqlite`));
  const portable = new URL('../single-instance.mjs',import.meta.url);
  const {acquireInstance} = await import(existsSync(portable) ? portable : new URL('../portable/single-instance.mjs',import.meta.url));
  const lock = await acquireInstance(project);
  if (!lock.primary) throw new Error('Stop Honeymoon before restoring the original map.');
  try {
    console.log(JSON.stringify(await restoreFromBackup(resolve(values['backup-world']),world,state,stateBackup),null,2));
  } finally { await lock.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
