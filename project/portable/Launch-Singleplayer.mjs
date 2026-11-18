import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {existsSync,readFileSync} from 'node:fs';
import { fileURLToPath } from 'node:url';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import { parseArgs } from 'node:util';
import { createHoneymoonServer } from './server/index.mjs';
import {readBuildNumber} from './server/build-version.mjs';
import {loadBase} from './server/base.mjs';
import {loadLodAssets,loadVistaAssets} from './server/lod-assets.mjs';
import {openLocalJournal} from './server/local-journal.mjs';
import { acquireInstance } from './single-instance.mjs';
import {createSoloCache} from './solo-cache.mjs';
import * as geometry from './world/geometry.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const state = join(root,'state','honeymoon.sqlite');
const { values } = parseArgs({ options: {
  port: { type: 'string', default: '4180' },
  'no-browser': { type: 'boolean' },
  'asset-origin': {type:'string'},
  offline: {type:'boolean'},
} });
const requestedPort = Number(values.port);
if (!/^\d+$/.test(values.port) || !Number.isSafeInteger(requestedPort) || requestedPort > 65535) {
  throw new Error('Укажите порт от 0 до 65535.');
}

const sourceFile=join(root,'solo-source.json');
const source=values['asset-origin'] ?? (existsSync(sourceFile) ? JSON.parse(readFileSync(sourceFile,'utf8')).origin : undefined);
const versionCheckInterval=10*60_000;

function savedRegionFiles(manifest) {
  if (!existsSync(state)) return [];
  const db=new DatabaseSync(state,{readOnly:true});
  const paths=new Set();
  function add(rx,rz) {
    const file=`full-world/${rx}.${rz}.bin`;
    if (Object.hasOwn(manifest.files,file)) paths.add(file);
  }
  try {
    const table=name=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (table('edits')) {
      for (const {rx,rz} of db.prepare('SELECT DISTINCT x >> 9 AS rx, z >> 9 AS rz FROM edits').all()) add(rx,rz);
    }
    if (table('module_state')) {
      for (const {value} of db.prepare("SELECT value FROM module_state WHERE module='single-player' AND key='position'").all()) {
        const {x,z}=JSON.parse(value) ?? {};
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        const cx=Math.floor(x/16), cz=Math.floor(z/16);
        for (let dx=-2;dx<=2;dx++) for (let dz=-2;dz<=2;dz++) add(Math.floor((cx+dx)/32),Math.floor((cz+dz)/32));
      }
    }
    return [...paths];
  } finally { db.close(); }
}

function show(url) {
  console.log(`Honeymoon — одиночная карта: ${url}`);
  if (values['no-browser']) return;
  const browser = spawn('explorer.exe', [url], { stdio: 'ignore', windowsHide: true });
  browser.on('error', () => console.log(`Откройте в браузере ${url}`));
  browser.unref();
}

async function listen(server, port=requestedPort) {
  try {
    server.listen(port, '127.0.0.1');
    await once(server, 'listening');
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
  return `http://127.0.0.1:${server.address().port}/`;
}

const instance = await acquireInstance(root);
if (!instance.primary) {
  show(instance.info.url);
} else {
  let app;
  let testRangeApp, openingTestRange;
  let cache, updateTimer, preparedBase;
  let closing;
  const close = () => closing ??= (async () => {
    clearInterval(updateTimer);
    try {
      await openingTestRange?.catch(()=>{});
      const results=await Promise.allSettled([cache?.close(),app?.close(),testRangeApp?.close()]);
      const failure=results.find(result=>result.status==='rejected');
      if (failure) throw failure.reason;
    }
    finally { await instance.close(); }
  })();
  function openTestRange() {
    if (closing) throw new Error('Honeymoon is closing');
    return openingTestRange ??= (async () => {
      const candidate=createHoneymoonServer({
        geometry,base:preparedBase,generated:cache?.directory,soloCache:cache,singlePlayer:true,
        state:join(root,'state','test-range','honeymoon.sqlite'),initialMode:'creative',soloWorld:'test-range',
        switchSoloWorld:()=>app.server.address()?.port,
      });
      try {
        const mainPort=app.server.address()?.port;
        const preferredPort=requestedPort>0 && requestedPort<65535 && mainPort===requestedPort ? requestedPort+1 : 0;
        await listen(candidate.server,preferredPort);
        testRangeApp=candidate;
        return candidate.server.address().port;
      } catch (error) {
        await candidate.close();
        throw error;
      }
    })().catch(error=>{
      openingTestRange=undefined;
      throw error;
    });
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.once(signal, () => { void close(); });
  }
  try {
    process.on('uncaughtExceptionMonitor', error=>openLocalJournal(state)?.record({
      kind:'server-error',message:String(error.message).slice(0,260),code:1,
    }));
    if (source !== undefined) {
      console.log('Проверяем локальные файлы карты и готовим стартовый район…');
      cache=await createSoloCache({cacheDirectory:join(root,'world-cache'),seedDirectory:join(root,'generated'),
        origin:source,requiredFiles(manifest) {
          if (manifest.build>readBuildNumber(root)) throw new Error('Для этой версии карты нужен новый запускатор.');
          return savedRegionFiles(manifest);
        },
        validateReady({directory,has}) {
          const candidate=loadBase(join(directory,'world'),{partial:{has}});
          if (!candidate.publicManifest?.fullChunks || !loadLodAssets(directory,candidate.hash) || !loadVistaAssets(directory)) {
            throw new Error('Стартовый набор карты несовместим с запускатором.');
          }
          preparedBase=candidate;
        },
        ...(values.offline&&{fetch:async()=>{throw new Error('Offline mode');}})});
      const status=cache.status();
      console.log(`Подготовлено ${Math.round(status.readyBytes/1048576)} МБ из ${Math.round(status.totalBytes/1048576)} МБ.`);
      if (!values.offline && cache.checkForUpdate) {
        updateTimer=setInterval(()=>void cache.checkForUpdate().catch(()=>{}),versionCheckInterval);
        updateTimer.unref();
      }
    }
    preparedBase ??= loadBase(join(root,'generated','world'));
    app = createHoneymoonServer({ geometry, state, singlePlayer:true, soloCache:cache,base:preparedBase,
      generated:cache?.directory,initialMode:cache?'creative':'game',soloWorld:'equestria',switchSoloWorld:openTestRange });
    const url = await listen(app.server);
    instance.publish({ mode: 'single-player', url });
    show(url);
    console.log('Оставьте это окно открытым во время игры. Для выхода нажмите Ctrl+C.');
    console.log('Скачать журнал диагностики: '+new URL('api/local-diagnostics',url));
  } catch (error) {
    await close();
    throw error;
  }
}
