import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { createHoneymoonServer } from './server/index.mjs';
import * as geometry from './world/geometry.mjs';

const { values } = parseArgs({ options: {
  port:{type:'string', default:'4173'}, lan:{type:'boolean'}, 'no-browser':{type:'boolean'},
} });
const port = Number(values.port);
if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port > 65535) throw new Error('Invalid --port');
const app = createHoneymoonServer({geometry});
try {
  app.server.listen(port, values.lan ? '0.0.0.0' : '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/`;
  console.log(`Honeymoon ${url}`);
  console.log('Keep this window open while playing. Press Ctrl+C to stop the server.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => app.close());
  if (!values['no-browser']) {
    const explorer = spawn('explorer.exe', [url], {stdio:'ignore', windowsHide:true});
    explorer.on('error', () => console.log(`Open ${url} in your browser.`));
    explorer.unref();
  }
} catch (error) {
  await app.close();
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is busy. For another port run: Start-Honeymoon.cmd --port 4174`);
    process.exitCode = 1;
  } else throw error;
}
