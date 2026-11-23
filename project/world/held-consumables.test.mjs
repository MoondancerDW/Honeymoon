import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {consumableName,consumableProfile,movementEffect,potionProfile} from './held-consumables.mjs';
import {classifyTool,harvestRule,hoedCell,meleeDamage} from './survival-tools.mjs';

test('every captured potion has an effect-specific name, drinking or throwing mode and valid dose',()=>{
  const variants=readFileSync(new URL('./flat-item-registry.tsv',import.meta.url),'utf8').split(/\r?\n/)
    .filter(row=>row.startsWith('373\t')).map(row=>Number(row.split('\t')[1]));
  assert.equal(variants.length,61);
  const profiles=variants.map(damage=>potionProfile(`creative:373:${damage}`));
  assert.equal(profiles.filter(profile=>profile.splash).length,30);
  assert.equal(new Set(profiles.map(profile=>profile.effect)).size,12);
  assert.ok(profiles.every(profile=>profile.name!=='Зелье'&&Boolean(profile.remaining)!==profile.splash));
  assert.equal(potionProfile('creative:373:16273').duration,45_000);
  assert.equal(potionProfile('creative:373:16370').amplifier,1);
  assert.equal(potionProfile('creative:373:32658').duration,135_000);
  assert.equal(potionProfile('creative:373:16307').duration,180_000);
  assert.equal(potionProfile('creative:373:16312').amplifier,0);
});

test('food heals and preserves containers, while eggs, cake items and pure seeds stay placeable',()=>{
  assert.equal(consumableName(4999,1).name,'Яблочный сидр');
  assert.equal(consumableProfile({key:'creative:4999:1'}).heal,4);
  assert.equal(consumableProfile({key:'creative:28013:0'}).remaining,'creative:281:0');
  assert.equal(consumableProfile({key:'creative:15281:0'}).remaining,'creative:374:0');
  for (const id of [344,354,295,15558]) assert.equal(consumableProfile({key:`creative:${id}:0`}),null);
});

test('hoes till unobstructed grass and dirt, and tool material and potion levels matter',()=>{
  assert.equal(classifyTool({key:'creative:290:0'}).tool,'hoe');
  assert.equal(hoedCell('legacy:2:0','air'),'legacy:60:0');
  assert.equal(hoedCell('legacy:3:0','legacy:1:0'),null);
  assert.equal(hoedCell('legacy:1:0','air'),null);
  assert.equal(meleeDamage(),1);
  assert.equal(meleeDamage({key:'creative:276:0'}),7);
  assert.equal(harvestRule('legacy:56:0',{key:'creative:271:0'}),null);
  assert.equal(harvestRule('legacy:56:0',{key:'creative:257:0'}).drops[0].key,'creative:264:0');
  assert.equal(movementEffect({speed:{amplifier:1},slowness:{amplifier:0}}),1.19);
});
