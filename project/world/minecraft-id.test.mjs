import assert from 'node:assert/strict';
import {test} from 'node:test';
import {formatMinecraftId,minecraftBlockCode,minecraftItemCode} from './minecraft-id.mjs';

test('Minecraft IDs retain the native registry number and only show nonzero variants',()=>{
  assert.equal(formatMinecraftId(minecraftBlockCode('legacy:142:0')),'id 142');
  assert.equal(formatMinecraftId(minecraftItemCode({key:'creative:373:8197'})),'id 373:8197');
  assert.equal(minecraftBlockCode({key:'cover:750:0:catalog-hash'}),'750:0');
  assert.equal(minecraftItemCode({key:'copy:part',part:{slot:18,shape:1,material:34}}),'750:4898');
  assert.equal(minecraftBlockCode('legacy:63:4'),'63:4');
  assert.equal(minecraftItemCode({key:'legacy:63:4'}),'323:0');
  assert.equal(minecraftBlockCode('game:switch'),null);
});
