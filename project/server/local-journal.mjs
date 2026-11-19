import {mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';

const maxEntries=100;

export function openLocalJournal(state) {
  if (state === ':memory:') return;
  const file=join(dirname(state),'local-diagnostics.json');
  let entries=[];
  try {
    const saved=JSON.parse(readFileSync(file,'utf8'));
    if (Array.isArray(saved)) entries=saved.slice(-maxEntries);
  } catch (error) {
    if (error.code!=='ENOENT') console.warn('Lilium Moonlight local diagnostics:',error.message);
  }
  return {
    read:()=>entries,
    record(event) {
      entries.push({...event,at:new Date().toISOString()});
      if (entries.length>maxEntries) entries.shift();
      try {
        mkdirSync(dirname(file),{recursive:true});
        writeFileSync(file+'.tmp',JSON.stringify(entries,null,2)+'\n');
        renameSync(file+'.tmp',file);
      } catch (error) { console.warn('Lilium Moonlight local diagnostics:',error.message); }
    },
  };
}
