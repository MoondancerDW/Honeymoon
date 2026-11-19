const entriesStore='entries';
const metaStore='meta';
const totalsKey='totals';
const lruIndex='lru';
const partitionIndex='partition-lru';
const policyKey='policy';

function resultOf(request) {
  return new Promise((resolve,reject)=>{
    request.onsuccess=()=>resolve(request.result);
    request.onerror=()=>reject(request.error);
  });
}

function committed(transaction) {
  return new Promise((resolve,reject)=>{
    transaction.oncomplete=resolve;
    transaction.onabort=()=>reject(transaction.error??new Error('Cache transaction aborted'));
  });
}

function trim(entries,totals,{bytes,count,oldest},partition,retire) {
  if (!totals.count) return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const index=entries.index(partition===null?lruIndex:partitionIndex);
    const range=partition===null?undefined:IDBKeyRange.bound([partition],[partition,[]]);
    const request=index.openKeyCursor(range);
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const cursor=request.result;
      if (!cursor) {resolve(); return;}
      const [accessed,size]=cursor.key.slice(-2);
      const fits=totals.bytes<=bytes && totals.count<=count && accessed>=oldest;
      if (fits && !retire) {
        resolve();
        return;
      }
      if (!fits || retire?.(cursor.primaryKey)) {
        entries.delete(cursor.primaryKey);
        totals.bytes-=size;
        totals.count--;
      }
      cursor.continue();
    };
  });
}

export function createPersistentCache({name,maxBytes,maxEntries,maxAgeMs,indexedDB,partitionOf,partitions,quotaReliefPartition}) {
  const partitioned=Boolean(partitionOf);
  const scopes=partitioned?Object.keys(partitions):[null];
  const defaultLimits={maxBytes,maxEntries,maxAgeMs};
  const scopeOf=key=>partitioned?partitionOf(key):null;
  const totalsAt=scope=>scope===null?totalsKey:`${totalsKey}:${scope}`;
  const emptyTotals=()=>({bytes:0,count:0});
  let connection;

  function upgrade(request,oldVersion) {
    const db=request.result;
    const transaction=request.transaction;
    const entries=oldVersion===0?db.createObjectStore(entriesStore):transaction.objectStore(entriesStore);
    const meta=oldVersion===0?db.createObjectStore(metaStore):transaction.objectStore(metaStore);
    if (oldVersion===0) entries.createIndex(lruIndex,['accessed','size']);
    if (!partitioned) return;
    entries.createIndex(partitionIndex,['partition','accessed','size']);
    if (oldVersion!==1) return;

    // The original terrain database is bounded to 160 MiB. Reindex its Blob handles
    // without reading their contents or keeping a duplicate database after upgrade.
    const totals=new Map(scopes.map(scope=>[scope,emptyTotals()]));
    const scan=entries.openCursor();
    scan.onsuccess=()=>{
      const cursor=scan.result;
      if (!cursor) {
        for (const [scope,usage] of totals) meta.put(usage,totalsAt(scope));
        meta.delete(totalsKey);
        return;
      }
      const partition=scopeOf(cursor.primaryKey);
      const usage=totals.get(partition);
      if (usage) {
        const entry=cursor.value;
        usage.bytes+=entry.size;
        usage.count++;
        cursor.update({...entry,partition});
      } else cursor.delete();
      cursor.continue();
    };
  }

  function database() {
    if (connection) return connection;
    const opening=new Promise((resolve,reject)=>{
      const factory=indexedDB===undefined ? globalThis.indexedDB : indexedDB;
      if (!factory) {reject(new Error('IndexedDB unavailable')); return;}
      const request=factory.open(name,partitioned?2:1);
      let blocked=false;
      request.onupgradeneeded=event=>upgrade(request,event.oldVersion);
      request.onerror=()=>reject(request.error);
      request.onblocked=()=>{
        blocked=true;
        reject(new Error('Opening cache database blocked'));
      };
      request.onsuccess=()=>{
        const db=request.result;
        if (blocked) {db.close(); return;}
        db.onversionchange=()=>{
          db.close();
          connection=undefined;
        };
        db.onclose=()=>{connection=undefined;};
        resolve(db);
      };
    });
    connection=opening.catch(error=>{
      connection=undefined;
      throw error;
    });
    return connection;
  }

  async function transact(operation,mode='readwrite') {
    const db=await database();
    const transaction=db.transaction([entriesStore,metaStore],mode);
    const completion=committed(transaction);
    // A request and the enclosing transaction can fail separately.
    completion.catch(()=>{});
    try {
      const result=await operation(transaction.objectStore(entriesStore),transaction.objectStore(metaStore));
      await completion;
      return result;
    } catch (error) {
      try {transaction.abort();} catch {}
      await completion.catch(()=>{});
      throw error;
    }
  }

  const readPolicy=async meta=>partitioned?(await resultOf(meta.get(policyKey))??partitions):null;
  const limitsFor=(policy,scope)=>scope===null?defaultLimits:policy[scope];
  const readTotals=async(meta,scope)=>await resultOf(meta.get(totalsAt(scope)))??emptyTotals();
  const saveTotals=(meta,scope,totals)=>resultOf(meta.put(totals,totalsAt(scope)));
  async function remove(entries,meta,key,scope,entry) {
    const totals=await readTotals(meta,scope);
    await resultOf(entries.delete(key));
    totals.bytes-=entry.size;
    totals.count--;
    await saveTotals(meta,scope,totals);
  }

  async function get(key) {
    try {
      return await transact(async(entries,meta)=>{
        const entry=await resultOf(entries.get(key));
        if (!entry) return null;
        const scope=scopeOf(key);
        const {maxAgeMs}=limitsFor(await readPolicy(meta),scope);
        const now=Date.now();
        if (entry.accessed<now-maxAgeMs) {
          await remove(entries,meta,key,scope,entry);
          return null;
        }
        // Avoid writing the same timestamp if several callers use an entry together.
        if (now!==entry.accessed) await resultOf(entries.put({...entry,accessed:now},key));
        return entry.blob;
      });
    } catch {return null;}
  }

  async function write(key,scope,blob) {
    return transact(async(entries,meta)=>{
      const {maxBytes,maxEntries,maxAgeMs}=limitsFor(await readPolicy(meta),scope);
      if (blob.size>maxBytes || maxEntries<1) return false;
      const totals=await readTotals(meta,scope);
      const previous=await resultOf(entries.get(key));
      if (previous) {
        await resultOf(entries.delete(key));
        totals.bytes-=previous.size;
        totals.count--;
      }
      const now=Date.now();
      await trim(entries,totals,{bytes:maxBytes-blob.size,count:maxEntries-1,oldest:now-maxAgeMs},scope);
      const entry={blob,size:blob.size,accessed:now,...(partitioned&&{partition:scope})};
      await resultOf(entries.put(entry,key));
      totals.bytes+=blob.size;
      totals.count++;
      await saveTotals(meta,scope,totals);
      return true;
    });
  }

  async function pruneScopes(affectedScopes,shrink=false,policy,retire={}) {
    return transact(async(entries,meta)=>{
      if (policy) await resultOf(meta.put(policy,policyKey));
      const limits=policy??await readPolicy(meta);
      for (const scope of affectedScopes) {
        const {maxBytes,maxEntries,maxAgeMs}=limitsFor(limits,scope);
        const totals=await readTotals(meta,scope);
        const bytes=shrink?Math.min(maxBytes,Math.floor(totals.bytes*.75)):maxBytes;
        await trim(entries,totals,{bytes,count:maxEntries,oldest:Date.now()-maxAgeMs},scope,retire[scope]);
        await saveTotals(meta,scope,totals);
      }
      return true;
    });
  }

  return {
    get,
    async put(key,blob) {
      const scope=scopeOf(key);
      if (!(blob instanceof Blob) || !scopes.includes(scope)) return false;
      try {
        return await write(key,scope,blob);
      } catch (error) {
        if (error?.name!=='QuotaExceededError') return false;
        try {
          // Commit the eviction separately so disk space is available to the retry.
          const affected=quotaReliefPartition && quotaReliefPartition!==scope?[quotaReliefPartition,scope]:[scope];
          await pruneScopes(affected,true);
          return await write(key,scope,blob);
        } catch {return false;}
      }
    },
    async delete(key) {
      try {
        return await transact(async(entries,meta)=>{
          const entry=await resultOf(entries.get(key));
          if (!entry) return false;
          await remove(entries,meta,key,scopeOf(key),entry);
          return true;
        });
      } catch {return false;}
    },
    async prune() {
      try {return await pruneScopes(scopes);}
      catch {return false;}
    },
    async configure(policy,retire) {
      if (!partitioned) return false;
      try {return await pruneScopes(scopes,false,policy,retire);}
      catch {return false;}
    },
    async missing(keys) {
      try {
        return await transact(async entries=>{
          const found=await Promise.all(keys.map(key=>resultOf(entries.getKey(key))));
          return keys.filter((_,index)=>found[index]===undefined);
        },'readonly');
      } catch {return null;}
    },
    async usage() {
      try {
        return await transact(async(_entries,meta)=>{
          const policy=await readPolicy(meta);
          const buckets={};
          const total={bytes:0,entries:0,maxBytes:0};
          for (const scope of scopes) {
            const {bytes,count:entries}=await readTotals(meta,scope);
            const {maxBytes}=limitsFor(policy,scope);
            buckets[scope]={bytes,entries,maxBytes};
            total.bytes+=bytes;
            total.entries+=entries;
            total.maxBytes+=maxBytes;
          }
          return partitioned?{...total,buckets}:total;
        },'readonly');
      } catch {return null;}
    },
  };
}
