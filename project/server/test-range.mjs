import {createHash} from 'node:crypto';
import {blockState} from '../world/block-interactions.mjs';
import {fluidState,plantBlock,plantSubstrate} from '../world/fluid-state.mjs';
import {publicMicroPart} from '../world/microblocks.mjs';
import {cellAddress,displayObject} from './base.mjs';
import {newCreativeObject} from './game.mjs';

const ground=64;
const bounds=Object.freeze({minX:-250,maxX:249,minY:0,maxY:255,minZ:-16,maxZ:483});
const blockRowWidth=60;
const frameRowWidth=80;
const frameLevels=2;
const frameRowSpacing=9;
const blockStart=8;
const floorKeys=['legacy:7:0','legacy:3:0','legacy:2:0','legacy:98:0'];
const standKey='legacy:1:0';
const rackKey='legacy:5:0';
const bedDirections=[[0,1],[-1,0],[0,-1],[1,0]];
const plants=new Set([...plantBlock.ground,...plantBlock.aquatic,18,81,106,127,175]);
const blockStatePattern=/^legacy:\d{1,4}:\d{1,2}$/;
const chunkId=(x,z)=>`${x}.${z}`;
const inBounds=(x,y,z)=>x>=bounds.minX&&x<bounds.maxX+1&&y>=bounds.minY&&y<bounds.maxY+1&&
  z>=bounds.minZ&&z<bounds.maxZ+1;
const solidFloor=(x,y,z)=>y===ground && Math.abs(x)<=2 && z>=0 ? floorKeys[3] : floorKeys[y-ground+2];
const emptyCell=Object.freeze({key:'air',object:null});
const hashOf=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function grouped(sequence, tabs) {
  const labels=new Map([...tabs.map(tab=>[tab.id,tab.label]),['states','Другие состояния']]);
  const groups=new Map(Array.from(labels,([id,label])=>[id,{label,entries:[]}]));
  for (const entry of sequence) {
    const section=groups.get(entry.category) ?? groups.get('states');
    section.entries.push(entry);
  }
  return Array.from(groups.values()).filter(section=>section.entries.length);
}

function sign(position, lines) {
  return {type:'Sign',position,key:`tile:${position.join(':')}`,
    data:Object.fromEntries(lines.map((line,index)=>[`Text${index+1}`,line]))};
}

export function createTestRange({catalog,placeable,items,blockStates=[]}) {
  const layout=new Map(), cells=new Map(), entities=new Map(), compositions={};
  const inventoryBlocks=catalog.entries.filter(entry=>placeable.has(entry.key));
  const blocks=new Map(inventoryBlocks.map(entry=>[entry.key,entry]));
  for (const key of blockStates) {
    if (blockStatePattern.test(key) && !blocks.has(key)) blocks.set(key,{key,category:'states'});
  }
  // Cover each catalog variant without trying to enumerate the combinations of editable pieces.
  const showcaseItems=Array.from(items.values());
  const blockSamples=[...blocks.values(),...showcaseItems.filter(entry=>entry.blockKey)];
  const blockGroups=grouped(blockSamples,catalog.tabs??[]);
  const blockItems=inventoryBlocks.map(entry=>({...entry,blockKey:entry.key}));
  const frameGroups=[
    ...grouped(showcaseItems,catalog.tabs??[]),
    ...grouped(blockItems,catalog.tabs??[]).map(group=>({...group,blockFrames:true})),
  ];
  function column(x,z) {
    const id=chunkId(x>>4,z>>4);
    if (!layout.has(id)) layout.set(id,{cells:[],entities:[]});
    return layout.get(id);
  }
  function place(position,key,object=null) {
    const [x,y,z]=position;
    if (!inBounds(x,y,z)) throw new Error(`Test exhibit outside range at ${position.join(',')}`);
    const address=cellAddress(x,y,z);
    if (cells.has(address)) throw new Error(`Test exhibits overlap at ${address}`);
    const cell={key,object};
    cells.set(address,cell);
    column(x,z).cells.push({position,...cell});
  }
  function placeSign(x,z,lines,meta=8) {
    const at=[x,ground+1,z];
    place(at,`legacy:63:${meta}`,sign(at,lines));
  }
  function sample(entry,x,z) {
    const y=ground+2;
    const position=[x,y,z];
    let key=entry.blockKey??entry.key;
    const [id,meta]=blockState(key);
    const support=[x,y-1,z];
    const door=id===64||id===71;
    const substrate=id===81 ? 12 : plants.has(id) ? plantSubstrate(id).values().next().value : null;
    const stand=door && (meta&8) ? `legacy:${id}:0` : substrate ? `legacy:${substrate}:0` : standKey;
    place(support,stand);
    let object=newCreativeObject(key,position,{against:support},entry);
    if (id===63||id===68) object=sign(position,['Образец',`${id}:${meta}`]);
    if (entry.part) {
      const part=publicMicroPart(entry.part);
      key=`cover:750:0:${hashOf(part)}`;
      compositions[key]={parts:[part]};
    }
    place(position,key,object);
    if (fluidState(key)) {
      for (const [dx,dz] of bedDirections) place([x+dx,y,z+dz],standKey);
    }
    if (door && !(meta&8)) place([x,y+1,z],`legacy:${id}:8`);
    if (id===26) {
      const [dx,dz]=bedDirections[meta&3];
      const direction=meta&8?-1:1;
      const otherX=x+dx*direction,otherZ=z+dz*direction;
      place([otherX,y-1,otherZ],standKey);
      place([otherX,y,otherZ],`legacy:26:${meta^8}`);
    }
  }
  let blockZ=blockStart;
  for (const {label,entries} of blockGroups) {
    placeSign(-4,blockZ,['Блоки',label]);
    for (const [i,entry] of entries.entries()) {
      sample(entry,-8-(i%blockRowWidth)*4,blockZ+Math.floor(i/blockRowWidth)*4);
    }
    blockZ+=Math.ceil(entries.length/blockRowWidth)*4+4;
  }
  let frameZ=blockStart;
  for (const {label,entries,blockFrames} of frameGroups) {
    placeSign(4,frameZ,[blockFrames?'Блоки в рамках':'Предметы',label]);
    for (const [i,entry] of entries.entries()) {
      const rack=Math.floor(i/frameLevels);
      const x=8+rack%frameRowWidth*3;
      const y=ground+2+i%frameLevels;
      const z=frameZ+Math.floor(rack/frameRowWidth)*frameRowSpacing;
      if (i%frameLevels===0) place([x,y-1,z],rackKey);
      place([x,y,z],rackKey);
      const key=`frame:${x}:${y}:${z}:2`;
      const frame={type:'ItemFrame',key,position:[x+.5,y+.5,z-.04],
        data:{TileX:x,TileY:y,TileZ:z,Direction:2,ItemRotation:0,
          Item:{id:entry.id,Damage:entry.damage??entry.meta??0,...(entry.blockKey && {Block:true})}}};
      if (!inBounds(...frame.position)) throw new Error(`Test frame outside range at ${frame.position.join(',')}`);
      column(x,z-1).entities.push(frame);
      entities.set(key,frame);
    }
    frameZ+=Math.ceil(entries.length/(frameRowWidth*frameLevels))*frameRowSpacing+4;
  }
  placeSign(-1,2,['Тестовый полигон','Блоки справа','Рамки слева']);
  const west=bounds.minX>>4,east=bounds.maxX>>4,north=bounds.minZ>>4,south=bounds.maxZ>>4;
  const hasPlayableChunk=(x,z)=>Number.isInteger(x)&&Number.isInteger(z)&&
    x>=west&&x<=east&&z>=north&&z<=south;
  const chunks=[];
  for(let z=north;z<=south;z++) {
    for(let x=west;x<=east;x++) chunks.push([x,z]);
  }
  const spawn=[.5,ground+1,.5];
  const hash=hashOf([1,bounds,[...cells],Array.from(entities.values())]);
  const manifest={schemaVersion:1,importVersion:1,catalogVersion:1,bounds,spawn,chunks,terrain:[],
    contentHash:hash,chunkPalettes:true,palette:['air'],compositions};
  const publicManifest={...manifest,compositions:{}};
  const palette=new Set(['air',...floorKeys,...Array.from(cells.values(),cell=>cell.key),...blocks.keys()]);

  function publicChunk(x,z,highOnly=false) {
    if(!hasPlayableChunk(x,z)) return null;
    if(highOnly) return {x,z,highOnly:true,palette:['air'],sections:[],objects:[],entities:[]};
    const content=layout.get(chunkId(x,z));
    const keys=['air',...floorKeys];
    const indices=new Map(keys.map((key,index)=>[key,index]));
    const sections=new Map();
    const definitions={};
    function write([wx,y,wz],key) {
      if (!indices.has(key)) {
        indices.set(key,keys.length);
        keys.push(key);
        if (compositions[key]) definitions[key]=compositions[key];
      }
      if (!sections.has(y>>4)) sections.set(y>>4,Buffer.alloc(8192));
      const index=(wx&15)+(wz&15)*16+(y&15)*256;
      sections.get(y>>4).writeUInt16LE(indices.get(key),index*2);
    }
    const firstX=Math.max(x*16,bounds.minX),lastX=Math.min(x*16+15,bounds.maxX);
    const firstZ=Math.max(z*16,bounds.minZ),lastZ=Math.min(z*16+15,bounds.maxZ);
    for(let wz=firstZ;wz<=lastZ;wz++) for(let wx=firstX;wx<=lastX;wx++) {
      for(let y=ground-2;y<=ground;y++) write([wx,y,wz],solidFloor(wx,y,wz));
    }
    const objects=[];
    for(const cell of content?.cells??[]) {
      write(cell.position,cell.key);
      if (cell.object) objects.push(displayObject(cell.object));
    }
    return {x,z,palette:keys,compositions:definitions,objects,entities:content?.entities??[],
      sections:Array.from(sections,([y,indices])=>({y,indices:indices.toString('base64')}))};
  }

  function getCell(x,y,z) {
    if (!inBounds(x,y,z)) return emptyCell;
    const sample=cells.get(cellAddress(x,y,z));
    if (sample) return sample;
    const key=y>=ground-2&&y<=ground ? solidFloor(x,y,z) : null;
    return key ? {key,object:null} : emptyCell;
  }

  function getEntity(x,z,key) {
    if (!inBounds(x,ground,z)) return undefined;
    const frame=entities.get(key);
    return frame && (Math.floor(frame.position[0])>>4)===(Math.floor(x)>>4) &&
      (Math.floor(frame.position[2])>>4)===(Math.floor(z)>>4) ? frame : undefined;
  }
  return {manifest,publicManifest,hash,catalog:palette,inBounds,getCell,getEntity,publicChunk,hasPlayableChunk,
    worldCoverage:hasPlayableChunk};
}
