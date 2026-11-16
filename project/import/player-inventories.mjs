import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync,realpathSync,statSync} from 'node:fs';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {gunzipSync} from 'node:zlib';
import {canonicalJson,readNbt} from './nbt.mjs';
import {stackFromRaw} from '../server/containers.mjs';
import {readCreativeCatalog} from '../server/creative-catalog.mjs';
import {normalizeLegacyPlayerName} from '../server/legacy-player.mjs';
import {openStore} from '../server/store.mjs';

const playerFile=/\.dat$/i;
const uuidPattern=/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const nilUuid='00000000-0000-0000-0000-000000000000';

function uuidFromBytes(bytes) {
  const value=bytes.toString('hex');
  return [value.slice(0,8),value.slice(8,12),value.slice(12,16),value.slice(16,20),value.slice(20)].join('-');
}

function savedUuid(data) {
  if (typeof data.UUID==='string' && uuidPattern.test(data.UUID) && data.UUID!==nilUuid) return data.UUID.toLowerCase();
  if (data.UUID?.$nbt==='ints') {
    const bytes=Buffer.from(data.UUID.base64,'base64');
    if (bytes.length===16 && bytes.some(Boolean)) return uuidFromBytes(bytes);
  }
  const {UUIDMost:high,UUIDLeast:low}=data;
  if (high?.$nbt==='long' && low?.$nbt==='long') {
    const bytes=Buffer.alloc(16);
    bytes.writeBigInt64BE(BigInt(high.value));
    bytes.writeBigInt64BE(BigInt(low.value),8);
    if (bytes.some(Boolean)) return uuidFromBytes(bytes);
  }
}

function offlineUuid(nickname) {
  // Java's UUID.nameUUIDFromBytes used by Minecraft's offline profiles.
  const bytes=createHash('md5').update('OfflinePlayer:'+nickname,'utf8').digest();
  bytes[6]=(bytes[6]&0x0f)|0x30;
  bytes[8]=(bytes[8]&0x3f)|0x80;
  return uuidFromBytes(bytes);
}

function importSlots(list,slots,getSlot,creative,report) {
  for (const item of list) {
    if (item?.Count===0 || item?.id===0) {
      report.emptyStacks++;
      continue;
    }
    const slot=getSlot(item?.Slot);
    if (!Number.isInteger(slot) || slot<0 || slot>=slots.length) {
      report.invalidSlots++;
      continue;
    }
    const stack=stackFromRaw(JSON.parse(canonicalJson(item)),creative.placeable,creative.items);
    if (!stack) {
      report.invalidStacks++;
      continue;
    }
    if (slots[slot]) report.duplicateSlots++;
    slots[slot]=stack;
  }
}

function playerRecord(bytes,file,nickname,creative,report) {
  const compressed=bytes[0]===0x1f && bytes[1]===0x8b;
  const data=readNbt(compressed?gunzipSync(bytes,{maxOutputLength:16*1024*1024}):bytes);
  if (!Array.isArray(data.Inventory) || data.EnderItems!==undefined && !Array.isArray(data.EnderItems)) {
    throw new Error('Invalid Inventory or EnderItems list');
  }
  const native=savedUuid(data);
  const slots=Array(40).fill(null);
  importSlots(data.Inventory,slots,slot=>{
    if (!Number.isInteger(slot)) return;
    if (slot>=100 && slot<=103) return 36+103-slot;
    return slot>=0 && slot<36 ? slot:undefined;
  },creative,report);
  const enderItems=Array(27).fill(null);
  importSlots(data.EnderItems??[],enderItems,slot=>slot,creative,report);
  const selected=Number.isInteger(data.SelectedItemSlot) && data.SelectedItemSlot>=0 && data.SelectedItemSlot<9 ? data.SelectedItemSlot:0;
  const inventory={slots:slots.slice(0,36),selected,equipment:slots.slice(36)};
  report[native?'nativeUids':'offlineUids']++;
  report.inventoryStacks+=inventory.slots.filter(Boolean).length;
  report.equipmentStacks+=inventory.equipment.filter(Boolean).length;
  report.enderStacks+=enderItems.filter(Boolean).length;
  return {uid:native??offlineUuid(nickname),nickname,inventory,enderItems,
    source:{file:'players/'+file,sha256:createHash('sha256').update(bytes).digest('hex')}};
}

function readCatalog(generated) {
  if (!statSync(join(generated,'creative','catalog.json'),{throwIfNoEntry:false})?.isFile()) {
    throw new Error('Missing creative/catalog.json under --generated');
  }
  let flatItems;
  const biblio=join(generated,'models','biblio.json');
  if (statSync(biblio,{throwIfNoEntry:false})?.isFile()) flatItems=JSON.parse(readFileSync(biblio,'utf8')).flatItems;
  return readCreativeCatalog(generated,undefined,flatItems);
}

function databaseOutsideSave(world,state) {
  if (state===':memory:') return state;
  const destination=resolve(state);
  const resolved=lstatSync(destination,{throwIfNoEntry:false}) ? realpathSync(destination) :
    join(realpathSync(dirname(destination)),basename(destination));
  const location=relative(world,resolved);
  if (!isAbsolute(location) && location!=='..' && !location.startsWith('..'+sep)) {
    throw new Error('--state must be outside the original Minecraft save');
  }
  return resolved;
}

export function importPlayerInventories({world,state,generated}) {
  if (!world || !state || !generated) throw new Error('Use --world, --state and --generated');
  const save=realpathSync(world);
  const database=databaseOutsideSave(save,state);
  const creative=readCatalog(generated);
  const files=readdirSync(join(save,'players'),{withFileTypes:true}).filter(file=>file.isFile() && playerFile.test(file.name))
    .map(file=>file.name).sort();
  if (!files.length) throw new Error('No named player saves found under --world/players');
  const report={files:files.length,inserted:0,existing:0,nativeUids:0,offlineUids:0,sharedUids:0,
    inventoryStacks:0,equipmentStacks:0,enderStacks:0,emptyStacks:0,invalidStacks:0,invalidSlots:0,duplicateSlots:0,skipped:[]};
  const records=new Map();
  const uidCounts=new Map();
  for (const file of files) {
    const nickname=file.replace(playerFile,'');
    const name=normalizeLegacyPlayerName(nickname);
    if (!name) {
      report.skipped.push({file,error:'Invalid profile name'});
      continue;
    }
    try {
      const record=playerRecord(readFileSync(join(save,'players',file)),file,nickname,creative,report);
      if (records.has(name)) {
        const previous=records.get(name);
        if (previous) report.skipped.push({file:previous.source.file.slice('players/'.length),error:'Ambiguous normalized profile name'});
        records.set(name,null);
        report.skipped.push({file,error:'Ambiguous normalized profile name'});
        continue;
      }
      records.set(name,record);
    } catch(error) {report.skipped.push({file,error:error.message});}
  }
  for (const record of records.values()) if (record) uidCounts.set(record.uid,(uidCounts.get(record.uid)??0)+1);
  report.sharedUids=[...uidCounts.values()].filter(count=>count>1).length;
  const store=openStore(database);
  try {
    store.atomic(()=>{
      for (const [name,record] of records) {
        if (!record) continue;
        if (store.getState('legacy-player',name,'import')) {report.existing++;continue;}
        store.putState('legacy-player',name,'import',1,record);
        report.inserted++;
      }
    });
  } finally {store.close();}
  return report;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const {values}=parseArgs({options:{world:{type:'string'},state:{type:'string'},generated:{type:'string'}}});
  const report=importPlayerInventories(values);
  console.log(JSON.stringify(report));
  if (report.skipped.length || report.invalidStacks || report.invalidSlots || report.duplicateSlots) process.exitCode=1;
}
