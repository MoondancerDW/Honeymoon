import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import {fileURLToPath} from 'node:url';
import { createHoneymoonServer } from './server/index.mjs';
import * as geometry from './world/geometry.mjs';
import {acquireInstance} from './single-instance.mjs';

const { values } = parseArgs({ options: {
  port:{type:'string', default:'4173'}, lan:{type:'boolean'}, internet:{type:'boolean'}, 'no-browser':{type:'boolean'},
} });
const requestedPort = Number(values.port);
if (!/^\d+$/.test(values.port) || !Number.isInteger(requestedPort) || requestedPort > 65535) throw new Error('Invalid --port');
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

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const browser = spawn(command,[url],{stdio:'ignore',windowsHide:true});
  browser.on('error',() => console.log(`Open ${url} in your browser.`));
  browser.unref();
}

const mode = values.internet ? 'internet' : values.lan ? 'lan' : 'local';
const instance = await acquireInstance(fileURLToPath(new URL('.',import.meta.url)));
if (!instance.primary) {
  const {info} = instance;
  if (mode !== 'local' && mode !== info.mode) {
    console.error(`Honeymoon is already running in ${info.mode} mode at ${info.url} Close that instance before starting ${mode} mode.`);
    process.exitCode = 1;
  } else {
    console.log(`Honeymoon is already running at ${info.url}`);
    if (info.publicUrl) console.log(`Public address: ${info.publicUrl}`);
    if (!values['no-browser']) openBrowser(info.url);
  }
} else {
  let app;
  let funnel;
  let closed;
  const close = () => closed ??= (async () => {
    try {
      if (funnel?.exitCode === null) funnel.kill();
      await app?.close();
    } finally { await instance.close(); }
  })();
  for (const signal of ['SIGINT','SIGTERM','SIGHUP','SIGBREAK']) process.once(signal,() => { void close(); });

  async function listenAvailable() {
    const host = values.lan ? '0.0.0.0' : '127.0.0.1';
    for (let candidate = requestedPort; candidate <= 65535; candidate++) {
      try {
        app.server.listen(candidate, host);
        await once(app.server, 'listening');
        if (candidate !== requestedPort) console.log(`Port ${requestedPort} is busy. Using port ${app.server.address().port}.`);
        return;
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
      }
    }
    throw new Error('No available port. Close an unused server and try again.');
  }

  try {
    const internet = values.internet ? internetRoute() : null;
    app = createHoneymoonServer({geometry, secure:Boolean(internet), allowedOrigin:internet?.url});
    await listenAvailable();
    const url = `http://127.0.0.1:${app.server.address().port}/`;
    instance.publish({mode,url,...(internet && {publicUrl:internet.url + '/'})});
    console.log('Keep this window open while playing. Close it or press Ctrl+C to stop the server.');
    if (internet) {
      console.log('Tailscale may ask you to enable Funnel in your browser.');
      console.log(`Honeymoon ${internet.url}/`);
      funnel = spawn(internet.command, ['funnel', '--https=443', url], {stdio:'inherit', windowsHide:true});
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
      if (!values['no-browser']) openBrowser(url);
    }
  } catch (error) {
    await close();
    throw error;
  }
}
