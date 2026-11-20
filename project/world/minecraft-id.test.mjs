import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {creativeMicroblock,microblockPartFromDamage} from './creative-items.mjs';
import {formatMinecraftId,minecraftBlockCode,minecraftItemCode,minecraftTargetCode} from './minecraft-id.mjs';
import {voxelBrush,voxelKey,writeVoxelBrush} from './voxel-chisel.mjs';

test('Minecraft tooltip IDs show the native registry number and metadata, including zero',()=>{
  assert.equal(formatMinecraftId(minecraftBlockCode('legacy:142:0')),'id 142:0');
  assert.equal(formatMinecraftId(minecraftItemCode({key:'creative:373:8197'})),'id 373:8197');
  assert.equal(minecraftBlockCode({key:'cover:750:0:catalog-hash'}),'750:0');
  assert.equal(minecraftBlockCode('legacy:63:4'),'63:4');
  assert.equal(minecraftItemCode({key:'legacy:63:4'}),'323:0');
  assert.equal(minecraftBlockCode('game:switch'),null);
});

test('RedPower part IDs use the captured native damage across the catalog, world and hotbar',()=>{
  const {entries}=JSON.parse(readFileSync(new URL('./creative-catalog.json',import.meta.url),'utf8'));
  const catalog=entries.filter(entry=>entry.kind==='microblock');
  assert.ok(catalog.length>1900);
  for (const entry of catalog) {
    const {slot,shape,material}=creativeMicroblock(entry);
    if (entry.english.endsWith(' Corner')) assert.equal(slot,6,entry.english);
    if (entry.english.endsWith(' Strip')) assert.equal(slot,14,entry.english);
    const part={slot,shape,material};
    const native=`750:${entry.damage}`;
    assert.deepEqual(microblockPartFromDamage(entry.damage),part,entry.english);
    assert.equal(minecraftTargetCode({cell:'cover:750:0:imported',part}),native);
    assert.equal(minecraftItemCode({key:'copy:part',part}),native);
  }
  const placed={slot:29,sourceSlot:9,shape:2,material:3,bounds:[[0,0,0,4,4,4]]};
  assert.equal(minecraftTargetCode({cell:'legacy:750:0',part:placed}),'750:5123');
  assert.equal(minecraftItemCode({key:'copy:part',part:{slot:18,shape:1,material:34}}),'750:5666');
});

test('chiseled voxels have distinct local sub-IDs by material, metadata and piece size',()=>{
  function target(size,material,x=0) {
    const voxels=writeVoxelBrush(null,voxelBrush(0,size),material);
    return {x,y:0,z:0,hit:{x:x+size/8,y:.05,z:.05},offset:[1,0,0],cell:{key:voxelKey,voxels}};
  }
  assert.equal(minecraftTargetCode(target(1,'legacy:1:0')),'750:65568');
  assert.equal(minecraftTargetCode(target(1,'legacy:1:0',-10)),'750:65568');
  assert.equal(minecraftTargetCode(target(2,'legacy:1:0')),'750:65569');
  assert.equal(minecraftTargetCode(target(1,'legacy:35:3')),'750:66662');
  assert.equal(minecraftTargetCode(target(1,'legacy:35:4')),'750:66664');
  assert.equal(minecraftTargetCode({cell:'legacy:35:4',voxel:0,voxelMaterial:'legacy:35:4'}),'35:4');
});
