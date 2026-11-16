import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {openStore} from './store.mjs';
import {createWarps} from './warps.mjs';

test('public warps and removals survive opening the same SQLite save again',()=>{
  const directory = mkdtempSync(join(tmpdir(),'honeymoon-warps-'));
  const path = join(directory,'state.sqlite');
  const point = {x:-31.425,y:70,z:.03};
  let store = openStore(path);
  try {
    const before = createWarps(store);
    assert.throws(()=>before.add('\t',point),{code:'invalid_warp_title'});
    const {warps:[warp]} = before.add('Особняк',point);
    store.close();
    store = openStore(path);
    const after = createWarps(store);
    assert.deepEqual(after.get(warp.id),warp);
    assert.throws(()=>after.remove('bad-id'),{code:'invalid_warp'});
    assert.deepEqual(after.remove(warp.id),{revision:2,warps:[]});
    store.close();
    store = openStore(path);
    assert.deepEqual(createWarps(store).list(),{revision:2,warps:[]});
  } finally {
    store.close();
    for (const file of ['state.sqlite','state.sqlite-wal','state.sqlite-shm']) rmSync(join(directory,file),{force:true});
    rmdirSync(directory);
  }
});
