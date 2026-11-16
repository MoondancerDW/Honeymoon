import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createWorldEdit,worldEditBlockLimit} from './world-edit.mjs';

const point=(x,y=65,z=0)=>({x,y,z});
const cell=(position,key,metadata={})=>({...position,cell:key,object:null,...metadata});
const key=({x,y,z})=>`${x},${y},${z}`;
const stone='legacy:1:0',stoneAlt='legacy:1:2',grass='legacy:2:0';

function fixture() {
  let held=true,creative=true,active=point(10),revision=0;
  const entries=new Map();
  const put=entry=>entries.set(key(entry),entry);
  const read=position=>entries.get(key(position))??cell(position,null);
  const editor=createWorldEdit({isAdmin:player=>player==='admin',isCreative:()=>creative,game:{
    position:()=>active,heldWoodenAxe:()=>held,inBounds:point=>point.y>0&&point.y<512&&Math.abs(point.x)<1000,
    canSelect:(player,point,hit)=>hit?.x===point.x,
    read,resolve:value=>[stone,stoneAlt,grass].includes(value),makeObject:()=>null,
    write:(player,entries)=>{
      if (entries.length) revision++;
      for (const entry of entries) put(entry);
      return {changes:entries,worldRevision:revision,effects:[]};
    },
  }});
  const action=(body,player='admin')=>editor.action(player,body);
  const select=(corner,position)=>action({action:'select',corner,...position,hit:position});
  const command=command=>action({action:'command',command});
  return {put,read,action,select,command,move:value=>{active=value;},axe:value=>{held=value;},mode:value=>{creative=value;}};
}

test('WorldEdit requires admin creative mode and a wooden axe only for selections',()=>{
  const {action,axe,mode,select,command,read}=fixture();
  assert.throws(()=>action({action:'clear'},'guest'),{code:'admin_required'});
  mode(false);
  assert.throws(()=>action({action:'clear'}),{code:'worldedit_creative_required'});
  mode(true);
  axe(false);
  assert.throws(()=>select(1,point(0)),{code:'worldedit_axe_required'});
  axe(true);
  assert.throws(()=>action({action:'select',corner:1,...point(0),hit:point(1)}),{code:'outside_reach'});
  select(1,point(0));select(2,point(2));
  axe(false);
  const result=command('//set 1:2');
  assert.equal(result.changed,3);
  assert.equal(result.worldRevision,1);
  assert.equal(read(point(1)).cell,stoneAlt);
  command('//replace 1 2');
  assert.equal(read(point(1)).cell,grass);
  command('//set 0');
  assert.equal(read(point(1)).cell,null);
  assert.throws(()=>action({action:'clear'}),{code:'worldedit_axe_required'});
});

test('clipboard preserves metadata, waterlogging, multipart and voxels relative to the user position',()=>{
  const {put,select,move,command,read}=fixture();
  const structure=cell(point(11),stone,{object:{type:'Chest',key:'tile:11:65:0',position:[11,65,0],
    data:{x:11,y:65,z:0,Items:[{id:387,tag:{title:'Notebook'}}]}},fluid:'water',
    parts:[{slot:1,shape:2,material:9}],voxels:{palette:['22'],indices:'aa=='}});
  put(structure);
  put(cell(point(22),grass));
  select(1,point(11));select(2,point(12));
  assert.equal(command('//copy').clipboard,2);
  move(point(20));
  assert.equal(command('//paste').changed,2);
  const pasted=read(point(21));
  assert.equal(pasted.fluid,'water');
  assert.deepEqual(pasted.parts,structure.parts);
  assert.deepEqual(pasted.voxels,structure.voxels);
  assert.equal(pasted.object.key,'tile:21:65:0');
  assert.equal(pasted.object.data.x,21);
  assert.deepEqual(pasted.object.data.Items,structure.object.data.Items);
  assert.equal(read(point(22)).cell,null);
  move(point(1000));
  assert.throws(()=>command('//paste'),{code:'outside_playable_area'});
});

test('bounded region and air masks reject invalid commands and preserve nonlegacy sculptures',()=>{
  const {put,read,select,command}=fixture();
  assert.throws(()=>command('//paste'),{code:'worldedit_clipboard_empty'});
  select(1,point(0));select(2,point(682,71));
  assert.throws(()=>command('//set 1'),{code:'worldedit_region_limit',details:{limit:worldEditBlockLimit}});
  select(2,point(2));
  put(cell(point(1),'generated:sculpture',{voxels:{palette:['22']}}));
  assert.equal(command('//replace 0 stone').changed,2);
  assert.equal(read(point(1)).cell,'generated:sculpture');
  assert.throws(()=>command('//set 4096'),{code:'worldedit_unknown_block'});
});
