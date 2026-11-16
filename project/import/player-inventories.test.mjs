import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename,dirname,join} from 'node:path';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {openStore} from '../server/store.mjs';
import {importPlayerInventories} from './player-inventories.mjs';

function value(method,bytes,input) {
  const result=Buffer.alloc(bytes);
  result[method](input);
  return result;
}

function text(input) {
  const contents=Buffer.from(input);
  return Buffer.concat([value('writeUInt16BE',2,contents.length),contents]);
}

const byte=input=>Buffer.of(input);
const short=input=>value('writeInt16BE',2,input);
const int=input=>value('writeInt32BE',4,input);
const long=input=>value('writeBigInt64BE',8,BigInt.asIntN(64,input));
const tag=(type,name,payload)=>Buffer.concat([byte(type),text(name),payload]);
const compound=(...children)=>Buffer.concat([...children,byte(0)]);
const list=(...items)=>Buffer.concat([byte(10),int(items.length),...items]);
const stack=(slot,id,count,extra=[])=>compound(tag(1,'Slot',byte(slot)),tag(2,'id',short(id)),
  tag(1,'Count',byte(count)),...extra);
const save=(...tags)=>gzipSync(tag(10,'',compound(...tags)));

test('imports legacy inventory order, exact UUIDs and metadata into an independent database',t=>{
  const temp=realpathSync(tmpdir());
  const fixture=mkdtempSync(join(temp,'honeymoon-player-import-'));
  t.after(()=>{
    const path=realpathSync(fixture);
    if (dirname(path)===temp && basename(path).startsWith('honeymoon-player-import-')) rmSync(path,{recursive:true,force:true});
  });
  const world=join(fixture,'save');
  const players=join(world,'players');
  const generated=join(fixture,'generated');
  const state=join(fixture,'honeymoon.sqlite');
  mkdirSync(players,{recursive:true});
  mkdirSync(join(generated,'creative'),{recursive:true});
  writeFileSync(join(generated,'creative','catalog.json'),JSON.stringify({schemaVersion:1,entries:[{key:'legacy:35:14'}]}));

  const uid='12345678-90ab-cdef-8a12-3456789abcde';
  const write=(name,contents)=>writeFileSync(join(players,name+'.dat'),contents);
  const root=(count)=>save(tag(4,'UUIDMost',long(0x1234567890abcdefn)),tag(4,'UUIDLeast',long(0x8a123456789abcden)),
    tag(3,'SelectedItemSlot',int(3)),tag(9,'Inventory',list(
      stack(3,35,count,[tag(2,'Damage',short(14)),tag(10,'tag',compound(
        tag(4,'Seed',long(-9223372036854775808n)),tag(7,'Custom',Buffer.concat([int(3),Buffer.of(0,255,1)]))))]),
      stack(100,313,1),stack(103,310,1),stack(7,0,1))),
    tag(9,'EnderItems',list(stack(26,4400,86,[tag(8,'ModExtra',text('original'))]))));
  write('Legacy Fox[1]',root(12));
  write('Legacy-Fox',save(tag(8,'UUID',text(uid.toUpperCase())),tag(9,'Inventory',list(stack(1,267,1)))));
  write('Notch',save(tag(9,'Inventory',list())));
  const input={world,state,generated};
  const initial=importPlayerInventories(input);
  assert.deepEqual([initial.inserted,initial.existing,initial.nativeUids,initial.offlineUids,initial.sharedUids],[3,0,2,1,1]);
  assert.deepEqual([initial.inventoryStacks,initial.equipmentStacks,initial.enderStacks,initial.emptyStacks],[2,2,1,1]);
  assert.deepEqual(initial.skipped,[]);

  let store=openStore(state);
  try {
    const {version,value:record}=store.getState('legacy-player','legacy fox[1]','import');
    assert.equal(version,1);
    assert.equal(record.uid,uid);
    assert.equal(record.nickname,'Legacy Fox[1]');
    assert.equal(record.source.file,'players/Legacy Fox[1].dat');
    assert.match(record.source.sha256,/^[a-f\d]{64}$/);
    assert.equal(record.inventory.selected,3);
    assert.equal(record.inventory.slots.length,36);
    assert.deepEqual(record.inventory.slots[3],{key:'legacy:35:14',cell:'legacy:35:14',count:12,nbt:{
      Custom:{$nbt:'bytes',base64:'AP8B'},Seed:{$nbt:'long',value:'-9223372036854775808'},
    }});
    assert.deepEqual(record.inventory.equipment.map(item=>item?.key??null),['creative:310:0',null,null,'creative:313:0']);
    assert.equal(record.enderItems.length,27);
    assert.deepEqual(record.enderItems[26],{key:'creative:4400:0',count:86,legacyNbt:{ModExtra:'original'}});
    assert.equal(store.getState('legacy-player','legacy-fox','import').value.uid,uid);
    assert.equal(store.getState('legacy-player','notch','import').value.uid,'b50ad385-829d-3141-a216-7e7d7539ba7f');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM players').get().count,0);
    store.createPlayer(uid);
    store.putState('legacy-player',uid,'claim',1,{uid,at:100});
    store.putState('inventory',uid,'slots',2,{slots:Array(36).fill(null),selected:8,equipment:Array(4).fill(null)});
  } finally {store.close();}

  write('Legacy Fox[1]',root(99));
  const repeated=importPlayerInventories(input);
  assert.deepEqual([repeated.inserted,repeated.existing],[0,3]);
  store=openStore(state);
  try {
    assert.equal(store.getState('legacy-player','legacy fox[1]','import').value.inventory.slots[3].count,12);
    assert.equal(store.getState('inventory',uid,'slots').value.selected,8);
    assert.equal(store.getState('legacy-player',uid,'claim').value.at,100);
  } finally {store.close();}
  assert.throws(()=>importPlayerInventories({...input,state:join(world,'accidental.sqlite')}),/outside the original Minecraft save/);
});
