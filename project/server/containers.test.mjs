import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import * as geometry from '../world/geometry.mjs';
import {containerSpec} from '../world/containers.mjs';
import {DETAIL_HEADER_SIZE,DETAIL_INDEX_OFFSET} from '../world/full-detail.mjs';
import {loadBase} from './base.mjs';
import {createGame} from './game.mjs';
import {openStore} from './store.mjs';

const empty = {key:'air',object:null};
const itemKey = 'creative:387:0';
const originalTag = {
  title:'Справочник',author:'Лилия',pages:['Оригинальная страница'],
  display:{Name:'§5Книга',Lore:['§lЧитать']},
  modData:{int64:{$nbt:'long',value:'11892379324890'},bytes:{type:'Buffer',data:[3,2,1]}},
};
const [a,b,c,d] = [[-5,1,4],[-4,1,4],[-3,1,4],[-2,1,4]];
const at = (position,type,cell,data = {}) => ({key:cell,object:{type,position,key:'tile:'+position.join(':'),data}});
const fixture = () => {
  const cells = new Map([
    [a.toString(),at(a,'Chest','legacy:54:3',{Items:[{id:387,Damage:0,Slot:7,Count:1,tag:originalTag,Extra:7}]})],
    [b.toString(),at(b,'Chest','legacy:54:3',{Items:[{id:1,Damage:0,Slot:13,Count:20}]})],
    [c.toString(),at(c,'BookcaseTile','legacy:2250:0',{Inventory:[{id:387,Damage:0,Slot:3,Count:1,tag:originalTag}]})],
    [d.toString(),at(d,'EnderChest','legacy:130:3')],
  ]);
  const bounds = {minX:-16,minY:0,minZ:0,maxX:15,maxY:15,maxZ:15};
  return {
    hash:'storage-fixture',
    manifest:{bounds,spawn:[-3.5,1,6.5],compositions:{}},
    catalog:new Set(['legacy:1:0',...Array.from(cells.values(),cell=>cell.key)]),
    inBounds:(x,y,z)=>x>=-16&&x<16&&[y,z].every(k=>k>=0&&k<16),
    getCell:(x,y,z)=>cells.get([x,y,z].join(',')) ?? (y===0 ? {key:'legacy:1:0',object:null} : empty),
  };
};

const slot = (side,slot) => ({side,slot});

function clients(t) {
  const base = fixture();
  const store = openStore(':memory:');
  t.after(()=>store.close());
  const start = () => createGame(base,store,geometry,{
    allowRemoval:true,modules:[],creativeBlocks:new Set(['legacy:1:0','legacy:54:3']),
    creativeItems:new Map([[itemKey,{id:387}]]),
  });
  let game = start();
  let sequence = 0;
  const add = () => {
    const player=store.createPlayer().id;
    game.session(player);
    const action=(type,[x,y,z]=a,rest={})=>game.action(player,{type,x,y,z,expectedRevision:0,
      requestId:'container-'+(++sequence),...rest});
    action.teleport=position=>game.teleport(player,position);
    action.drops=()=>game.droppedItemSnapshot(player);
    return action;
  };
  return {add,base,store,restart(){game=start();}};
}

test('double chest preserves original slots, NBT, optimistic transfers and persistent edits',t=>{
  const {add,restart,store} = clients(t);
  const first = add(),second = add();
  const opened = first('container_open',a).output;
  assert.equal(opened.container.title,'Двойной сундук');
  assert.equal(opened.container.slots.length,54);
  assert.equal(opened.container.slots[7].key,itemKey);
  assert.equal(opened.container.slots[27+13].count,20);
  assert.ok(opened.changes.every(change=>change.object.data.open && !change.object.data.Items));
  const move = {version:opened.container.version,from:slot('storage',7),to:slot('inventory',9)};
  const withdrawn = first('container_move',a,move);
  assert.equal(withdrawn.status,200);
  assert.deepEqual(withdrawn.output.inventory.slots[9].nbt,originalTag);
  assert.deepEqual(withdrawn.output.inventory.slots[9].legacyNbt,{Extra:7});
  assert.equal(withdrawn.output.container.slots[7],null);
  const stale=second('container_move',b,move);
  assert.equal(stale.status,409);
  assert.equal(stale.output.error,'stale_container');
  assert.equal(stale.output.container.slots[7],null);
  restart();
  const read=first('container_read',b).output;
  const deposited=first('container_move',b,{version:read.container.version,from:slot('inventory',9),to:slot('storage',31)});
  assert.equal(deposited.status,200);
  assert.equal(deposited.output.inventory.slots[9],null);
  assert.deepEqual(store.getEdit(...b).object.data.Items.find(item=>item.Slot===4),{
    id:387,Damage:0,Count:1,Slot:4,tag:originalTag,Extra:7,
  });
  assert.deepEqual(second('container_read',a).output.container.slots[31].nbt,originalTag);
});

test('staged chest responses send counts first and keep a content version across lid changes',t=>{
  const {add}=clients(t);
  const first=add();
  const open=first('container_open',a,{containerView:'summary'}).output;
  assert.equal(open.container.counts.length,54);
  assert.equal(open.container.counts[7],1);
  assert.equal(open.container.counts[40],20);
  assert.equal(open.container.counts[0],null);
  assert.equal(open.container.slots,undefined);
  assert.equal(open.inventory,undefined);
  assert.doesNotMatch(JSON.stringify(open),/Оригинальная страница/);

  const close=first('container_close',a,{containerView:'summary'}).output.container;
  assert.notEqual(open.container.version,close.version);
  assert.equal(open.container.contentVersion,close.contentVersion);
  const details=first('container_read',a,{containerView:'details'}).output;
  assert.equal(details.container.contentVersion,close.contentVersion);
  assert.deepEqual(details.container.slots[7].nbt,originalTag);
  assert.equal(details.inventory,undefined);

  const moved=first('container_move',a,{containerView:'details',version:close.version,
    from:slot('storage',7),to:slot('inventory',9)}).output;
  assert.notEqual(moved.container.contentVersion,close.contentVersion);
  assert.deepEqual(moved.inventory.slots[9].nbt,originalTag);
  assert.equal(first('container_read',a,{containerView:'summary'}).output.container.counts[7],null);
});

test('independent ender inventories and original modded shelf write back their exact fields',t=>{
  const {add,store}=clients(t);
  const first=add(),second=add();
  const shelf=first('container_open',c).output;
  assert.equal(shelf.container.slots[3].key,itemKey);
  const take=first('container_move',c,{version:shelf.container.version,from:slot('storage',3),to:slot('inventory',0)});
  assert.equal(take.status,200);
  assert.deepEqual(store.getEdit(...c).object.data.Inventory,[]);
  assert.equal(store.getEdit(...c).object.data.filledTopSlots,0);
  const {container}=first('container_open',d).output;
  assert.equal(container.title,'Сундук Края');
  assert.equal(first('container_move',d,{version:container.version,from:slot('inventory',0),to:slot('storage',8)}).status,200);
  assert.deepEqual(first('container_read',d).output.container.slots[8].nbt,originalTag);
  assert.equal(second('container_read',d).output.container.slots[8],null);
});

test('Jammy and RedPower slots follow their native slot counts and storage metadata',()=>{
  assert.equal(containerSpec('legacy:200:4').size,6);
  assert.equal(containerSpec('legacy:201:6').size,9);
  assert.equal(containerSpec('legacy:201:13'),undefined);
  assert.equal(containerSpec('legacy:205:5').field,'FriFreItems');
  assert.equal(containerSpec('legacy:206:5').field,'wmItems');
  assert.equal(containerSpec('legacy:751:2').size,20);
  assert.equal(containerSpec('legacy:763:10').size,27);
  assert.equal(containerSpec('legacy:2250:0').size,16);
});

test('an old lid edit recovers original storage while breaking a chest keeps item NBT in its drops',t=>{
  const {add,base,store}=clients(t);
  const player=add();
  const source=base.getCell(...a);
  const [x,y,z]=a;
  const revision=store.nextRevision();
  store.writeEdit({x,y,z,cell:source.key,revision,object:{...source.object,data:{open:true}}},source.key);
  assert.deepEqual(player('container_read',a).output.container.slots[7].nbt,originalTag);

  player.teleport({x:x+.5,y,z:z+1.35});
  assert.equal(player('remove',a,{expectedRevision:revision}).status,200);
  assert.equal(player.drops().length,1);
  const pickup=player('pickup_item',a);
  assert.equal(pickup.status,200);
  assert.equal(pickup.output.inventory.slots[0].key,itemKey);
  assert.deepEqual(pickup.output.inventory.slots[0].nbt,originalTag);
  assert.deepEqual(pickup.output.inventory.slots[0].legacyNbt,{Extra:7});
  assert.deepEqual(player.drops(),[]);
  assert.equal(player('container_read',b).output.container.slots[13].count,20);
});

test('a newly placed chest starts empty and persists inventory added by a player',t=>{
  const {add,restart}=clients(t);
  const player=add(), other=add();
  const lower=[-1,1,5];
  const opened=player('container_open',a).output;
  assert.equal(player('container_move',a,{version:opened.container.version,
    from:slot('storage',7),to:slot('inventory',0)}).status,200);
  player.teleport({x:-.5,y:1,z:6.5});
  const placed=player('place',lower,{cell:'legacy:54:3',creative:true,
    against:{x:-1,y:0,z:5},hit:{x:-.5,y:1,z:5.5}});
  assert.equal(placed.status,200,JSON.stringify(placed.output));
  const fresh=player('container_open',lower).output.container;
  assert.equal(fresh.slots.length,27);
  assert.ok(fresh.slots.every(item=>item===null));
  assert.equal(player('container_move',lower,{version:fresh.version,
    from:slot('inventory',0),to:slot('storage',17)}).status,200);
  restart();
  assert.deepEqual(other('container_read',lower).output.container.slots[17].nbt,originalTag);
});

test('compiled local chunks borrow private original inventories without publishing them',t=>{
  const root=mkdtempSync(join(tmpdir(),'honeymoon-storage-fixture-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const world=join(root,'world'), detail=join(root,'full-world');
  mkdirSync(join(world,'chunks'),{recursive:true});
  mkdirSync(detail);
  const sourceHash='a'.repeat(64), mask=Buffer.alloc(128);
  mask[0]=1;
  const bounds={minX:0,maxX:15,minY:0,maxY:255,minZ:0,maxZ:15};
  writeFileSync(join(world,'world.json'),JSON.stringify({schemaVersion:1,chunkPalettes:true,palette:['air'],
    spawn:[.5,1,.5],contentHash:sourceHash,bounds,chunks:[[0,0]]}));
  writeFileSync(join(detail,'manifest.json'),JSON.stringify({version:1,sourceHash,hash:'b'.repeat(64),
    bounds:[0,0,0,0],regions:[[0,0,mask.toString('base64')]]}));
  const pos=[4,1,4];
  const sourceCell=fixture().getCell(...a);
  const original={...sourceCell,object:{...sourceCell.object,position:pos,key:'tile:4:1:4'}};
  const local={x:0,z:0,palette:['air',original.key],entities:[],compositions:{}};
  const indices=Buffer.alloc(8192);
  indices.writeUInt16LE(1,(pos[0]+pos[2]*16+pos[1]*256)*2);
  local.sections=[{y:0,indices:indices.toString('base64')}];
  writeFileSync(join(world,'chunks','0.0.json'),JSON.stringify({...local,objects:[{...original.object,data:{}}]}));
  const payload=gzipSync(JSON.stringify({...local,objects:[original.object]}));
  const header=Buffer.alloc(DETAIL_HEADER_SIZE);
  header.write('HDTL');
  header.writeUInt16LE(1,4);
  header.writeUInt32LE(header.length,DETAIL_INDEX_OFFSET);
  header.writeUInt32LE(payload.length,DETAIL_INDEX_OFFSET+4);
  writeFileSync(join(detail,'0.0.bin'),Buffer.concat([header,payload]));

  const base=loadBase(world);
  assert.deepEqual(base.getCell(...pos),original);
  assert.deepEqual(base.publicChunk(0,0).objects[0].data,{});
});
