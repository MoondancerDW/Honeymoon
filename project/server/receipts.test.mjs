import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test} from 'node:test';
import * as geometry from '../world/geometry.mjs';
import {createGame} from './game.mjs';
import {openStore,receiptLimits} from './store.mjs';

const time=2_000_000;
const input=JSON.stringify({type:'inventory_select',slot:0});
const save=(store,player,id,output={},at=time)=>store.putReceipt(player,id,input,200,output,at);
const usage=(store,owner='')=>store.db.prepare('SELECT entries,bytes FROM receipt_usage WHERE owner=?').get(owner);

test('legacy migration retains recent receipts and preserves the rest of the save',()=>{
  const folder=mkdtempSync(join(tmpdir(),'honeymoon-receipts-'));
  const path=join(folder,'migration.sqlite');
  const old=openStore(path);
  const player=old.createPlayer().id;
  const peer=old.createPlayer().id;
  old.putState('inventory',player,'slots',2,{selected:8});
  old.close();
  const legacy=new DatabaseSync(path);
  legacy.exec(`DROP TABLE receipts; DROP TABLE receipt_usage;
    CREATE TABLE receipts(player TEXT NOT NULL REFERENCES players(id), id TEXT NOT NULL,
      input TEXT NOT NULL,status INTEGER NOT NULL,output TEXT NOT NULL,PRIMARY KEY(player,id)) STRICT;
    PRAGMA user_version=9; BEGIN`);
  const insert=legacy.prepare('INSERT INTO receipts VALUES (?,?,?,?,?)');
  for (let i=0;i<receiptLimits.playerRows+5;i++) insert.run(player,`legacy-${i}`,input,200,JSON.stringify({i}));
  insert.run(peer,'legacy-peer',input,409,'{"error":"occupied"}');
  insert.run(player,'legacy-oversized',input,200,JSON.stringify({payload:'a'.repeat(receiptLimits.entryBytes)}));
  legacy.exec('COMMIT');
  legacy.close();
  const upgraded=openStore(path);
  try {
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version,11);
    assert.equal(upgraded.getState('inventory',player,'slots').value.selected,8);
    assert.equal(upgraded.getReceipt(player,'legacy-0'),undefined);
    assert.deepEqual(upgraded.getReceipt(player,'legacy-oversized'),{input,status:409,output:{error:'action_result_expired'}});
    assert.deepEqual(upgraded.getReceipt(peer,'legacy-peer'),{input,status:409,output:{error:'occupied'}});
    assert.equal(upgraded.getReceipt(player,`legacy-${receiptLimits.playerRows+4}`).output.i,receiptLimits.playerRows+4);
    assert.equal(usage(upgraded,player).entries,receiptLimits.playerRows);
    assert.equal(usage(upgraded).entries,receiptLimits.playerRows+1);
    assert.equal(upgraded.db.prepare('PRAGMA quick_check').get().quick_check,'ok');
  } finally {
    upgraded.close();
    for (const file of [path,path+'-wal',path+'-shm']) rmSync(file,{force:true});
    rmdirSync(folder);
  }
});

test('receipt expiry and byte accounting preserve recent retries and bound retained payloads',()=>{
  const store=openStore(':memory:');
  try {
    const player=store.createPlayer().id;
    store.atomic(()=>{
      save(store,player,'cutoff-id',{stored:true},time-receiptLimits.age);
      save(store,player,'recent-id',{stored:true},time-receiptLimits.age+1);
      save(store,player,'oversized-id',{payload:'雪'.repeat(receiptLimits.entryBytes/2)});
    });
    assert.equal(store.getReceipt(player,'cutoff-id',time),undefined);
    assert.equal(store.getReceipt(player,'recent-id',time).output.stored,true);
    assert.deepEqual(store.getReceipt(player,'oversized-id',time),{input,status:409,output:{error:'action_result_expired'}});
    assert.equal(store.pruneReceipts(time),1);
    store.atomic(()=>save(store,player,'cutoff-id',{insertedAgain:true}));
    assert.equal(store.getReceipt(player,'cutoff-id',time).output.insertedAgain,true);

    const payload={data:'雪'.repeat(84_000)};
    const players=[player,...Array.from({length:8},()=>store.createPlayer().id)];
    store.atomic(()=>{
      for (const actor of players) {
        for (let i=0;i<35;i++) save(store,actor,`payload-${i}`,payload);
        assert.ok(usage(store,actor).bytes<=receiptLimits.playerBytes);
        assert.equal(store.getReceipt(actor,'payload-0',time),undefined);
      }
    });
    const global=usage(store);
    assert.ok(global.bytes<=receiptLimits.totalBytes && global.bytes>receiptLimits.totalBytes-256*1024);
    assert.equal(store.getReceipt(player,'payload-2',time),undefined);
    assert.deepEqual(store.getReceipt(players.at(-1),'payload-34',time).output,payload);
    assert.equal(store.pruneReceipts(time+receiptLimits.age),global.entries);
    assert.equal(usage(store).bytes,0);
  } finally { store.close(); }
});

test('count limits favor recent receipts with transactional accounting and reused SQLite pages',()=>{
  const store=openStore(':memory:');
  try {
    const players=Array.from({length:9},()=>store.createPlayer().id);
    store.atomic(()=>{
      for (const actor of players) {
        for (let i=0;i<receiptLimits.playerRows+1;i++) save(store,actor,`quota-id${i}`);
        assert.equal(usage(store,actor).entries,receiptLimits.playerRows);
        assert.equal(store.getReceipt(actor,'quota-id0',time),undefined);
      }
    });
    const latest=players.at(-1);
    assert.equal(usage(store).entries,receiptLimits.totalRows);
    assert.equal(usage(store,players[0]),undefined);
    assert.ok(store.getReceipt(latest,`quota-id${receiptLimits.playerRows}`,time));
    assert.throws(()=>store.atomic(()=>{save(store,latest,'must-rollback');throw new Error('rollback');}),/rollback/);
    assert.equal(store.getReceipt(latest,'must-rollback',time),undefined);
    assert.equal(usage(store).entries,receiptLimits.totalRows);
    const pages=store.db.prepare('PRAGMA page_count').get().page_count;
    store.pruneReceipts(time+receiptLimits.age);
    assert.ok(store.db.prepare('PRAGMA freelist_count').get().freelist_count>0);
    assert.equal(usage(store).entries,0);
    store.atomic(()=>{for (let i=0;i<receiptLimits.playerRows;i++) save(store,latest,`fresh-id${i}`);});
    assert.equal(store.db.prepare('PRAGMA page_count').get().page_count,pages);
  } finally { store.close(); }
});

test('rate limits new IDs without throttling replays or sustained placement speed',()=>{
  const store=openStore(':memory:');
  try {
    let now=time;
    const base={hash:'receipt-fixture',manifest:{spawn:[8.5,1,8.5],bounds:{minX:0,maxX:15,minY:0,maxY:15,minZ:0,maxZ:15}},
      catalog:new Set(['legacy:1:0']),inBounds:(x,y,z)=>[x,y,z].every(value=>value>=0&&value<16),
      getCell:(x,y,z)=>({key:y===0?'legacy:1:0':'air',object:null})};
    const game=createGame(base,store,geometry,{modules:[],clock:()=>now});
    const [player,...peers]=Array.from({length:9},()=>store.createPlayer().id);
    const act=(actor,i,type='inventory_select',slot=0)=>game.action(actor,{type,slot,requestId:`request-${i}`});
    for (let i=0;i<48;i++) assert.equal(act(player,i,'inventory_copy').status,409);
    assert.throws(()=>act(player,48),{status:429,code:'action_rate_limit'});
    assert.equal(act(player,0,'inventory_copy').replay,true);
    assert.throws(()=>act(player,0),{status:409,code:'request_id_reused'});
    assert.equal(usage(store,player).entries,48);
    for (const peer of peers.slice(0,7)) for (let i=0;i<48;i++) assert.equal(act(peer,i).status,200);
    assert.throws(()=>act(peers.at(-1),0),{status:429,code:'action_rate_limit'});
    assert.equal(usage(store,peers.at(-1)),undefined);
    for (let i=0;i<100;i++) {
      now+=150;
      assert.equal(act(player,i+48).status,200);
    }
    now+=receiptLimits.age;
    game.advance();
    assert.equal(usage(store).entries,0);
  } finally { store.close(); }
});
