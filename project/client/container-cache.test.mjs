import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createContainerCache} from './container-cache.mjs';

test('container cache expires records and bounds both retained count and weight',()=>{
  let now=0;
  const cache=createContainerCache({limit:2,ttl:10,capacity:6,sizeOf:value=>value.length,clock:()=>now});
  cache.set('a','aaa');
  cache.set('b','bbb');
  assert.equal(cache.get('a'),'aaa');
  cache.set('c','c');
  assert.equal(cache.get('b'),undefined);
  cache.set('d','dddd');
  assert.equal(cache.get('a'),undefined);
  assert.equal(cache.get('c'),'c');
  cache.set('oversized','b'.repeat(7));
  assert.equal(cache.get('oversized'),undefined);
  now=10;
  assert.equal(cache.get('d'),undefined);
});
