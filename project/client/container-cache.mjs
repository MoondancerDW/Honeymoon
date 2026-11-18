export function createContainerCache({limit,ttl,capacity=Infinity,sizeOf=()=>1,clock=Date.now}) {
  const entries=new Map();
  let used=0;

  function remove(key) {
    const entry=entries.get(key);
    if (!entry) return;
    used-=entry.weight;
    entries.delete(key);
  }

  function prune() {
    const now=clock();
    for (const [key,entry] of entries) if (entry.expires<=now) remove(key);
  }

  return {
    get(key) {
      prune();
      const entry=entries.get(key);
      if (!entry) return;
      entries.delete(key);
      entries.set(key,entry);
      return entry.value;
    },
    set(key,value) {
      prune();
      remove(key);
      const weight=sizeOf(value);
      if (weight>capacity) return;
      entries.set(key,{value,weight,expires:clock()+ttl});
      used+=weight;
      while (entries.size>limit || used>capacity) remove(entries.keys().next().value);
    },
    forEach(callback) {
      prune();
      for (const entry of entries.values()) callback(entry.value);
    },
    prune,
    remove,
  };
}
