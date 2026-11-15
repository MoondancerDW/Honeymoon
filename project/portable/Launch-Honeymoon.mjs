import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import { createHoneymoonServer } from './server/index.mjs';
import * as geometry from './world/geometry.mjs';

const { values } = parseArgs({ options: {
  port:{type:'string', default:'4173'}, lan:{type:'boolean'}, internet:{type:'boolean'}, 'no-browser':{type:'boolean'},
} });
const port = Number(values.port);
if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port > 65535) throw new Error('Invalid --port');
if (values.lan && values.internet) throw new Error('Choose one option: --lan or --internet');

function internetRoute() {
  const installed = join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
  const command = existsSync(installed) ? installed : 'tailscale.exe';
  let status;
  try {
    status = JSON.parse(execFileSync(command, ['status', '--json'], {encoding:'utf8', timeout:10000, windowsHide:true}));
  } catch {
    throw new Error('Install Tailscale from https://tailscale.com/download/windows and sign in.');
  }
  const hostname = status.Self?.DNSName?.replace(/\.$/, '');
  if (status.BackendState !== 'Running' || !/^[a-z0-9.-]+\.ts\.net$/i.test(hostname ?? '')) {
    throw new Error('Open Tailscale and sign in. Enable MagicDNS and HTTPS if prompted.');
  }
  return {command, url:`https://${hostname}`};
}

const internet = values.internet ? internetRoute() : null;
const app = createHoneymoonServer({geometry, secure:Boolean(internet), allowedOrigin:internet?.url});
let closed;
const close = () => closed ??= app.close();
try {
  app.server.listen(port, values.lan ? '0.0.0.0' : '127.0.0.1');
  await once(app.server, 'listening');
  const url = `http://127.0.0.1:${app.server.address().port}/`;
  console.log('Keep this window open while playing. Press Ctrl+C to stop the server.');
  if (internet) {
    console.log('Tailscale may ask you to enable Funnel in your browser.');
    console.log(`Honeymoon ${internet.url}/`);
    const funnel = spawn(internet.command, ['funnel', '--https=443', url], {stdio:'inherit', windowsHide:true});
    const stop = () => { if (funnel.exitCode === null) funnel.kill(); void close(); };
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, stop);
    const [code] = await once(funnel, 'exit');
    await close();
    if (code) process.exitCode = code;
  } else {
    console.log(`Honeymoon ${url}`);
    if (values.lan) {
      for (const [name, addresses] of Object.entries(networkInterfaces())) {
        for (const address of addresses.filter(item => !item.internal && item.family === 'IPv4')) {
          console.log(`${name} http://${address.address}:${app.server.address().port}/`);
        }
      }
    }
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, close);
    if (!values['no-browser']) {
      const explorer = spawn('explorer.exe', [url], {stdio:'ignore', windowsHide:true});
      explorer.on('error', () => console.log(`Open ${url} in your browser.`));
      explorer.unref();
    }
  }
} catch (error) {
  await close();
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is busy. For another port run: Start-Honeymoon.cmd --port 4174`);
    process.exitCode = 1;
  } else throw error;
}
