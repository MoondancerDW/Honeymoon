import {createPersistentCache} from './persistent-cache.mjs';
import {cellKey,json} from './world-data.mjs';

const cache = createPersistentCache({name:'honeymoon-world-checkpoints-v1',maxBytes:64*1024*1024,maxEntries:4,
  maxAgeMs:30*24*60*60_000});

export const worldCheckpointUsage=()=>cache.usage();

function editMap(edits) {
  return new Map(edits.map(edit=>[cellKey(edit.x,edit.y,edit.z),edit]));
}

async function readCheckpoint(key) {
  try {
    const blob=await cache.get(key);
    if (!blob) return null;
    const {epoch,revision,edits}=JSON.parse(await blob.text());
    if (typeof epoch!=='string' || !Number.isSafeInteger(revision) || revision<0 || !Array.isArray(edits) ||
        !edits.every(edit=>edit && [edit.x,edit.y,edit.z,edit.revision].every(Number.isSafeInteger))) return null;
    return {epoch,revision,edits:editMap(edits)};
  } catch {return null;}
}

export function createWorldCheckpoint(key) {
  let saved, initialized=false, pending=Promise.resolve();
  void cache.prune();

  async function load() {
    if (saved===undefined) saved=await readCheckpoint(key);
    const query=new URLSearchParams({delta:'1'});
    if (saved) {
      query.set('epoch',saved.epoch);
      query.set('since',String(saved.revision));
    }
    const snapshot=await json('/api/world?'+query);
    if (!Array.isArray(snapshot.edits)) return snapshot;
    if (initialized && snapshot.complete) return {...snapshot,restart:true};
    const edits=snapshot.complete ? editMap(snapshot.edits) : saved.edits;
    if (!snapshot.complete) {
      for (const edit of snapshot.edits) edits.set(cellKey(edit.x,edit.y,edit.z),edit);
    }
    const overrides=initialized ? snapshot.edits : [...edits.values()];
    const {epoch,worldRevision:revision}=snapshot;
    if (snapshot.complete || revision!==saved?.revision) {
      const blob=new Blob([JSON.stringify({epoch,revision,edits:[...edits.values()]})],{type:'application/json'});
      void cache.put(key,blob);
    }
    saved={epoch,revision,edits};
    initialized=true;
    return {...snapshot,overrides:[...overrides,...snapshot.mechanicOverrides]};
  }

  return {
    refresh() {
      const next=pending.then(load);
      pending=next.catch(()=>{});
      return next;
    },
    epoch:()=>initialized ? saved?.epoch : undefined,
  };
}
