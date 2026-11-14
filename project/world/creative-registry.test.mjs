import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {buildCreativeCatalog, compactCreativeCatalog} from './creative-registry.mjs';

test('keeps every real block ID, preserves map-only variants and excludes Forge item placeholders', () => {
  function state(id, meta, fields) {
    return {id:String(id), meta:String(meta), creative:'false', stackName:'', stackKey:'',
      blockName:'', class:'amq', translation:'Zucchini Crop', tab:'', textureFile:'/terrain.png',
      faces:'0,0,0,0,0,0', ...fields};
  }
  const rows = Array.from({length:16}, (_, meta) => [
    state(1,meta,{class:'aml', blockName:'tile.stone', creative:String(meta === 0),
      nameRu:'Камень', nameEn:'Stone', tab:'buildingBlocks', faces:'1,1,1,1,1,1'}),
    state(256,meta,{stackName:'Iron Shovel', stackKey:'item.shovelIron', creative:String(meta === 0)}),
    state(750,meta,{class:'com.eloraam.redpower.base.BlockMicro'}),
  ]).flat();
  const parts = [
    {id:'750',damage:'0',name:'Cobblestone Cover',coverData:'65536'},
    {id:'750',damage:'256',name:'Red Alloy Wire',coverData:'0'},
    {id:'750',damage:'2048',name:'Pneumatic Tube'},
  ];
  const catalog = buildCreativeCatalog(rows, ['air','legacy:1:4','cover:750:0:a'], parts);
  const entries = new Map(catalog.entries.map(entry => [entry.key,entry]));
  assert.equal(entries.get('legacy:1:0').name,'Камень');
  assert.equal(entries.get('legacy:1:4').onMap,true);
  assert.equal(entries.get('legacy:750:0').placeable,false);
  assert.equal(entries.get('creative:750:0').category,'microblocks');
  assert.equal(entries.get('creative:750:256').blockKey,'legacy:750:1');
  assert.equal(entries.get('creative:750:2048').kind,'tube');
  assert.deepEqual(catalog.provenance.forgePlaceholderIds,[256]);
  assert.equal(catalog.counts.registered,2);
  assert.equal(compactCreativeCatalog(catalog).entries[0].textureFile,undefined);
});

test('checks the shipped creative catalog has unique keys and includes the captured variant families', () => {
  const {entries,tabs,counts} = JSON.parse(readFileSync(new URL('./creative-catalog.json',import.meta.url),'utf8'));
  const byKey = new Map(entries.map(entry => [entry.key,entry]));
  const byId = new Set(entries.map(entry => entry.id));
  const uniqueTabs = new Set(tabs.map(tab => tab.id));
  assert.equal(byKey.size,entries.length);
  assert.equal(counts.sourceSlots,counts.registered + counts.forgePlaceholders);
  assert.equal(byId.size,counts.registered);
  assert.equal(counts.entries,entries.length);
  assert.equal(counts.placeable,entries.filter(entry => entry.placeable !== false).length);
  assert.ok(entries.every(entry => uniqueTabs.has(entry.category)));
  assert.equal(byKey.get('legacy:1:0').english,'Stone');
  assert.equal(byKey.get('creative:768:63').kind,'shaped-lamp');
  assert.equal(byKey.get('creative:750:2816').kind,'tube');
  assert.equal(byKey.get('creative:750:16666').kind,'jacket');
  assert.equal(byKey.get('creative:753:272').kind,'logic');
  assert.equal(byKey.get('creative:750:3072').kind,'wire');
  assert.ok(entries.filter(entry => entry.kind === 'microblock').length > 1900);
});
