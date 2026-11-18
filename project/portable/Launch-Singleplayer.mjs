import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import {join} from 'node:path';
import { parseArgs } from 'node:util';
import { createHoneymoonServer } from './server/index.mjs';
import {openLocalJournal} from './server/local-journal.mjs';
import { acquireInstance } from './single-instance.mjs';
import * as geometry from './world/geometry.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const state = join(root,'state','honeymoon.sqlite');
const { values } = parseArgs({ options: {
  port: { type: 'string', default: '4180' },
  'no-browser': { type: 'boolean' },
} });
const requestedPort = Number(values.port);
if (!/^\d+$/.test(values.port) || !Number.isSafeInteger(requestedPort) || requestedPort > 65535) {
  throw new Error('Укажите порт от 0 до 65535.');
}

function show(url) {
  console.log(`Honeymoon — одиночная карта: ${url}`);
  if (values['no-browser']) return;
  const browser = spawn('explorer.exe', [url], { stdio: 'ignore', windowsHide: true });
  browser.on('error', () => console.log(`Откройте в браузере ${url}`));
  browser.unref();
}

async function listen(server) {
  try {
    server.listen(requestedPort, '127.0.0.1');
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
  let closing;
  const close = () => closing ??= (async () => {
    try { await app?.close(); }
    finally { await instance.close(); }
  })();
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    process.once(signal, () => { void close(); });
  }
  try {
    process.on('uncaughtExceptionMonitor', error=>openLocalJournal(state)?.record({
      kind:'server-error',message:String(error.message).slice(0,260),code:1,
    }));
    app = createHoneymoonServer({ geometry, state, singlePlayer: true, initialMode: 'game' });
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
