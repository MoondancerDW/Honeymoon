import {test} from 'node:test';
import assert from 'node:assert/strict';
import {iconSignature,inventoryItemEntry} from './creative-icons.mjs';

test('signed book resolves its sprite variant and title before the catalog arrives',()=>{
  const entry = inventoryItemEntry({key:'creative:387:0',count:1,nbt:{title:'§aПисьмо',author:'Пони'}});
  assert.deepEqual(entry,{key:'creative:387:0',id:387,damage:0,name:'Письмо'});
  assert.equal(iconSignature(entry),iconSignature({...entry,name:'Другое название'}));
});

test('inventory keeps copied geometry and distinguishes color and shaped variants',()=>{
  const cloth = inventoryItemEntry({key:'legacy:35:1',count:2});
  const alternate = inventoryItemEntry({key:'legacy:35:2',count:1});
  assert.notEqual(iconSignature(cloth),iconSignature(alternate));
  const part = inventoryItemEntry({key:'creative:750:4',cell:'legacy:750:0',part:{material:4,shape:'cover'}});
  assert.equal(part.blockKey,'legacy:750:0');
  assert.equal(part.kind,'microblock');
  assert.notEqual(iconSignature(part),iconSignature({...part,part:{...part.part,shape:'panel'}}));
});
