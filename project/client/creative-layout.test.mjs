import assert from 'node:assert/strict';
import {test} from 'node:test';
import {arrangeCreativeCatalog} from './creative-layout.mjs';

const entry = (key,extra = {}) => ({key,...extra});

test('creative tabs keep legacy order and place native aliases with their original icon', () => {
  const door = entry('legacy:64:0'), doorItem = entry('creative:324:0',{kind:'flat-item'});
  const glass = entry('legacy:20:0'), spruce = entry('legacy:5:1'), oak = entry('legacy:5:0');
  const dirt = entry('legacy:3:0'), technicalDoor = entry('legacy:64:9',{technical:true});
  const catalog = arrangeCreativeCatalog([glass,technicalDoor,spruce,doorItem,oak,dirt,door,dirt]);
  const build = catalog.tabs.find(tab=>tab.id === 'buildingBlocks');
  const redstone = catalog.tabs.find(tab=>tab.id === 'redstone');
  assert.deepEqual(build.cards.map(card=>card.entry),[dirt,oak,spruce,glass]);
  assert.deepEqual(redstone.cards.find(card=>card.entry === door),{entry:door,icon:doorItem,code:'324:0'});
  assert.equal(catalog.cards.filter(card=>card.entry.key === door.key).length,1);
  assert.ok(!catalog.cards.some(card=>card.entry === doorItem || card.entry === technicalDoor));
  assert.equal(catalog.byKey.get(technicalDoor.key),technicalDoor);
  assert.equal(catalog.tabs.length,21);
});

test('creative tabs retain original item metadata while deduplicating each stack identity', () => {
  const books = entry('creative:403:0',{kind:'flat-item'});
  const goldSword = entry('creative:283:0',{kind:'flat-item'});
  const wool = [entry('legacy:35:0'),entry('legacy:35:1')];
  const frame = entry('creative:389:0',{kind:'item-frame'});
  const invisible = entry('creative:389:1',{kind:'item-frame'});
  const catalog = arrangeCreativeCatalog([books,goldSword,...wool,frame,invisible]);
  const combat = catalog.tabs.find(tab=>tab.id === 'combat');
  const build = catalog.tabs.find(tab=>tab.id === 'buildingBlocks');
  const decor = catalog.tabs.find(tab=>tab.id === 'decorations');
  assert.equal(combat.cards.filter(card=>card.entry === books).length,1);
  assert.deepEqual(build.cards.map(card=>card.entry),wool);
  assert.deepEqual(decor.cards.map(card=>card.entry),[frame,invisible]);
});
