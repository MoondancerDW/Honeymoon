import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as geometry from '../world/geometry.mjs';
import {grassBlock,plainDirt} from '../world/tree-logs.mjs';
import {createGame} from './game.mjs';
import {openStore} from './store.mjs';

const oak='legacy:17:0';
const moddedLog='legacy:2163:1';
const texturedDirt='legacy:3:1';
const wrongLog='legacy:162:0';
const stone='legacy:1:0';
const ground=(x,z=6)=>({x,y:1,z});
const trunk=(x,z=6)=>({x,y:2,z});
const block=(point,cell)=>({...point,cell,object:null});
const address=({x,y,z})=>`${x},${y},${z}`;

function fixture(t,original=[],coverage={}) {
  const cells=new Map(original.map(cell=>[address(cell),cell.cell]));
  const base={
    hash:'log-ground-fixture',
    manifest:{spawn:[5.5,1,8.5],bounds:{minX:0,maxX:31,minY:0,maxY:15,minZ:0,maxZ:15}},
    catalog:new Set([plainDirt,grassBlock,oak,moddedLog,texturedDirt,wrongLog,stone]),
    inBounds:(x,y,z)=>x>=0&&x<=31&&y>=0&&y<=15&&z>=0&&z<=15,
    getCell:(x,y,z)=>({key:cells.get(address({x,y,z}))??(y===0?stone:'air'),object:null}),
    ...coverage,
  };
  const store=openStore(':memory:');
  t.after(()=>store.close());
  const {id:owner}=store.createPlayer();
  const {id:builder}=store.createPlayer();
  const open=()=>createGame(base,store,geometry,{allowRemoval:true});
  const saved=(point,cell,player=owner)=>{
    const {x,y,z}=point;
    store.writeEdit({...block(point,cell),revision:store.nextRevision()},JSON.stringify(base.getCell(x,y,z)),player);
  };
  return {owner,builder,store,open,saved};
}

test('placing a log turns its dirt support into grass and removing the log leaves the grass intact',t=>{
  const {owner,store,open}=fixture(t,[block(ground(6),plainDirt),block(ground(7),grassBlock)]);
  const game=open();
  const place=(x,cell)=>game.action(owner,{
    type:'place',requestId:'place-block-'+x,expectedRevision:0,cell,...trunk(x),against:ground(x),
  });
  const placed=place(6,oak);
  assert.equal(placed.status,200,JSON.stringify(placed.output));
  assert.deepEqual(placed.output.changes.map(({cell,revision})=>[cell,revision]),[[oak,1],[grassBlock,1]]);
  assert.equal(store.getEditOwner(6,2,6),owner);
  assert.equal(store.getEditOwner(6,1,6),null,'placing the log does not take ownership of the support');
  const removed=game.action(owner,{type:'remove',requestId:'remove-log',expectedRevision:1,...trunk(6)});
  assert.equal(removed.status,200,JSON.stringify(removed.output));
  assert.deepEqual(removed.output.changes.map(({cell})=>cell),[null]);
  assert.equal(place(7,stone).status,200);
  assert.equal(open().worldEdit.read(ground(6)).cell,grassBlock);
  assert.equal(open().worldEdit.read(ground(7)).cell,grassBlock);
});

test('bulk placement checks the final cells and preserves existing ownership and dirt variants',t=>{
  const {owner,builder,store,open,saved}=fixture(t);
  const game=open();
  saved(ground(7),plainDirt);
  const output=game.worldEdit.write(builder,[
    block(trunk(6),moddedLog),block(ground(6),plainDirt),block(trunk(7),oak),
    block(trunk(8),oak),block(ground(8),texturedDirt),
    block(trunk(9),wrongLog),block(ground(9),plainDirt),
  ]);
  assert.equal(output.changes.length,8);
  assert.equal(game.worldEdit.read(ground(6)).cell,grassBlock);
  assert.equal(game.worldEdit.read(ground(7)).cell,grassBlock);
  assert.equal(game.worldEdit.read(ground(8)).cell,texturedDirt);
  assert.equal(game.worldEdit.read(ground(9)).cell,plainDirt);
  assert.equal(store.getEditOwner(6,1,6),builder);
  assert.equal(store.getEditOwner(7,1,6),owner);
});

test('saved dirt and log edits migrate once their chunk is available',t=>{
  let distantAvailable=false;
  const {owner,store,open,saved}=fixture(t,[
    block(ground(6),plainDirt),block(trunk(7),oak),block(trunk(8),oak),
    block(ground(21),plainDirt),
  ],{
    hasPlayableChunk:(x,z)=>z===0&&(x===0||x===1&&distantAvailable),
    worldCoverage:(x,z)=>z===0&&(x===0||x===1),
  });
  const initial=open();
  saved(trunk(6),moddedLog);
  saved(ground(7),plainDirt);
  saved(ground(8),plainDirt);
  saved(trunk(8),null,null);
  saved(trunk(21),oak);
  assert.equal(initial.worldRevision(),5);

  const game=open();
  assert.equal(game.worldRevision(),6);
  assert.equal(game.worldEdit.read(ground(6)).cell,grassBlock);
  assert.equal(game.worldEdit.read(ground(7)).cell,grassBlock);
  assert.equal(game.worldEdit.read(ground(8)).cell,plainDirt,'the saved log removal takes precedence');
  assert.equal(store.getEditOwner(7,1,6),owner);
  assert.equal(game.resolveLogGround(1,0),undefined);
  assert.equal(game.worldRevision(),6);

  distantAvailable=true;
  const commit=game.resolveLogGround(1,0);
  assert.deepEqual(commit.changes,[{...block(ground(21),grassBlock),revision:7}]);
  assert.equal(commit.worldRevision,7);
  assert.equal(game.resolveLogGround(1,0),undefined);
  assert.equal(open().worldRevision(),7);
});
