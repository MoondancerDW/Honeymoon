const entriesStore='entries';
const metaStore='meta';
const totalsKey='totals';
const lruIndex='lru';

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

function trim(entries,totals,{bytes,count,oldest}) {
  if (!totals.count) return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const request=entries.index(lruIndex).openKeyCursor();
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const cursor=request.result;
      if (!cursor) {resolve(); return;}
      const [accessed,size]=cursor.key;
      if (totals.bytes<=bytes && totals.count<=count && accessed>=oldest) {
        resolve();
        return;
      }
      entries.delete(cursor.primaryKey);
      totals.bytes-=size;
      totals.count--;
      cursor.continue();
    };
  });
}

export function createPersistentCache({name,maxBytes,maxEntries,maxAgeMs,indexedDB}) {
  let connection;
  function database() {
    if (connection) return connection;
    const opening=new Promise((resolve,reject)=>{
      const factory=indexedDB===undefined ? globalThis.indexedDB : indexedDB;
      if (!factory) {reject(new Error('IndexedDB unavailable')); return;}
      const request=factory.open(name,1);
      let blocked=false;
      request.onupgradeneeded=()=>{
        const db=request.result;
        db.createObjectStore(entriesStore).createIndex(lruIndex,['accessed','size']);
        db.createObjectStore(metaStore);
      };
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

  async function transact(operation) {
    const db=await database();
    const transaction=db.transaction([entriesStore,metaStore],'readwrite');
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

  const readTotals=async meta=>await resultOf(meta.get(totalsKey))??{bytes:0,count:0};
  const saveTotals=(meta,totals)=>resultOf(meta.put(totals,totalsKey));
  async function remove(entries,meta,key,entry) {
    const totals=await readTotals(meta);
    await resultOf(entries.delete(key));
    totals.bytes-=entry.size;
    totals.count--;
    await saveTotals(meta,totals);
  }

  async function get(key) {
    try {
      return await transact(async(entries,meta)=>{
        const entry=await resultOf(entries.get(key));
        if (!entry) return null;
        const now=Date.now();
        if (entry.accessed<now-maxAgeMs) {
          await remove(entries,meta,key,entry);
          return null;
        }
        // Avoid writing the same timestamp if several callers use an entry together.
        if (now!==entry.accessed) await resultOf(entries.put({...entry,accessed:now},key));
        return entry.blob;
      });
    } catch {return null;}
  }

  async function write(key,blob) {
    return transact(async(entries,meta)=>{
      const totals=await readTotals(meta);
      const previous=await resultOf(entries.get(key));
      if (previous) {
        await resultOf(entries.delete(key));
        totals.bytes-=previous.size;
        totals.count--;
      }
      const now=Date.now();
      await trim(entries,totals,{bytes:maxBytes-blob.size,count:maxEntries-1,oldest:now-maxAgeMs});
      await resultOf(entries.put({blob,size:blob.size,accessed:now},key));
      totals.bytes+=blob.size;
      totals.count++;
      await saveTotals(meta,totals);
      return true;
    });
  }

  async function pruneBytes(byteLimit) {
    return transact(async(entries,meta)=>{
      const totals=await readTotals(meta);
      await trim(entries,totals,{bytes:byteLimit(totals),count:maxEntries,oldest:Date.now()-maxAgeMs});
      await saveTotals(meta,totals);
      return true;
    });
  }

  return {
    get,
    async put(key,blob) {
      if (!(blob instanceof Blob) || blob.size>maxBytes || maxEntries<1) return false;
      try {
        return await write(key,blob);
      } catch (error) {
        if (error?.name!=='QuotaExceededError') return false;
        try {
          // Commit the eviction separately so disk space is available to the retry.
          await pruneBytes(totals=>Math.floor(totals.bytes*.75));
          return await write(key,blob);
        } catch {return false;}
      }
    },
    async delete(key) {
      try {
        return await transact(async(entries,meta)=>{
          const entry=await resultOf(entries.get(key));
          if (!entry) return false;
          await remove(entries,meta,key,entry);
          return true;
        });
      } catch {return false;}
    },
    async prune() {
      try {return await pruneBytes(()=>maxBytes);}
      catch {return false;}
    },
  };
}
