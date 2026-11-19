import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { parseArgs } from 'node:util';
import {fileURLToPath} from 'node:url';
import { createHoneymoonServer } from './server/index.mjs';
import * as geometry from './world/geometry.mjs';
import {acquireInstance} from './single-instance.mjs';

const { values } = parseArgs({ options: {
  port:{type:'string', default:'4173'}, lan:{type:'boolean'}, tailscale:{type:'boolean'},
  internet:{type:'boolean'}, 'no-browser':{type:'boolean'},
} });
const requestedPort = Number(values.port);
if (!/^\d+$/.test(values.port) || !Number.isInteger(requestedPort) || requestedPort > 65535) throw new Error('Invalid --port');
if ([values.lan,values.tailscale,values.internet].filter(Boolean).length>1) throw new Error('Choose one option: --lan, --tailscale or --internet');

const root=fileURLToPath(new URL('.',import.meta.url));
function editorKey() {
  if (process.env.HONEYMOON_NPC_ADMIN_KEY) return process.env.HONEYMOON_NPC_ADMIN_KEY;
  const state = join(root,'state');
  const path = join(state,'npc-admin.key');
  mkdirSync(state,{recursive:true});
  try { writeFileSync(path,randomBytes(24).toString('base64url')+'\n',{flag:'wx',mode:0o600}); }
  catch (error) { if (error.code!=='EEXIST') throw error; }
  const key = readFileSync(path,'utf8').trim();
  if (key.length<16) throw new Error('Owner key must contain at least 16 characters. See '+path);
  console.log(`Owner key file: ${path}`);
  return key;
}

function internetRoute() {
  const installed = join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
  const command = process.env.HONEYMOON_TAILSCALE_EXECUTABLE || (existsSync(installed) ? installed : 'tailscale.exe');
  let status, routes;
  try {
    status = JSON.parse(execFileSync(command, ['status', '--json'], {encoding:'utf8', timeout:10000, windowsHide:true}));
    routes = JSON.parse(execFileSync(command,['serve','status','--json'],{encoding:'utf8',timeout:10000,windowsHide:true}));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Install Tailscale from https://tailscale.com/download/windows and sign in.');
    throw new Error('Could not read current Tailscale status and routes. Check that Tailscale is running and try again.');
  }
  const hostname = status.Self?.DNSName?.replace(/\.$/, '');
  if (status.BackendState !== 'Running' || !/^[a-z0-9.-]+\.ts\.net$/i.test(hostname ?? '')) {
    throw new Error('Open Tailscale and sign in. Enable MagicDNS and HTTPS if prompted.');
  }
  const configurations = [routes,...Object.values(routes?.Foreground??{}),...Object.values(routes?.Services??{})];
  const inUse = new Set(configurations.flatMap(config => [
    ...Object.keys(config?.TCP??{}),
    ...[...Object.keys(config?.Web??{}),...Object.keys(config?.AllowFunnel??{})].map(route => route.split(':').at(-1)),
  ]));
  const port=[443,8443,10000].find(candidate=>!inUse.has(String(candidate)));
  if (!port) throw new Error('Tailscale ports 443, 8443 and 10000 are already in use.');
  return {command,port,url:`https://${hostname}${port===443?'':':'+port}`};
}

function openBrowser(url) {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const browser = spawn(command,[url],{stdio:'ignore',windowsHide:true});
  browser.on('error',() => console.log(`Open ${url} in your browser.`));
  browser.unref();
}

const mode = values.internet ? 'internet' : values.tailscale ? 'tailscale' : values.lan ? 'lan' : 'local';
const instance = await acquireInstance(root);
if (!instance.primary) {
  const {info} = instance;
  if (mode !== 'local' && mode !== info.mode) {
    console.error(`Lilium Moonlight is already running in ${info.mode} mode at ${info.url} Close that instance before starting ${mode} mode.`);
    process.exitCode = 1;
  } else {
    console.log(`Lilium Moonlight is already running at ${info.url}`);
    if (info.publicUrl) console.log(`Public address: ${info.publicUrl}`);
    if (!values['no-browser']) openBrowser(info.url);
  }
} else {
  let app;
  let tunnel;
  let closed;
  const close = () => closed ??= (async () => {
    try {
      if (tunnel?.exitCode === null) tunnel.kill();
      await app?.close();
    } finally { await instance.close(); }
  })();
  for (const signal of ['SIGINT','SIGTERM','SIGHUP','SIGBREAK']) process.once(signal,() => { void close(); });

  async function listenAvailable(server, host, startPort) {
    for (let candidate = startPort; candidate <= 65535; candidate++) {
      try {
        server.listen(candidate, host);
        await once(server, 'listening');
        if (candidate !== startPort) console.log(`Port ${startPort} is busy. Using port ${server.address().port}.`);
        return server.address().port;
      } catch (error) {
        if (error.code !== 'EADDRINUSE') throw error;
      }
    }
    throw new Error('No available port. Close an unused server and try again.');
  }

  try {
    const remote = values.internet || values.tailscale ? internetRoute() : null;
    const lanAddresses = values.lan ? Object.entries(networkInterfaces()).flatMap(([name, addresses]) =>
      addresses.filter(item => !item.internal && item.family === 'IPv4').map(item => ({name,address:item.address}))) : [];
    let localOrigin;
    let availableLanOrigin;
    app = createHoneymoonServer({
      geometry,
      secure:Boolean(remote),
      allowedOrigin:remote?.url,
      publicOrigin:() => remote?.url ?? availableLanOrigin ?? localOrigin,
      inviteRequired:true,
      monitorNetwork:values.internet,
      ownerOnPrimary:mode==='local',
      npcAdminKey:editorKey(),
      initialMode:'game',
    });
    const gamePort = await listenAvailable(app.server,values.lan ? '0.0.0.0' : '127.0.0.1',requestedPort);
    const gameUrl = `http://127.0.0.1:${gamePort}/`;
    const lanAddress = lanAddresses.find(item => !/tailscale|vethernet|virtual/i.test(item.name)) ?? lanAddresses[0];
    if (lanAddress) availableLanOrigin = `http://${lanAddress.address}:${gamePort}`;
    if (mode === 'local') {
      localOrigin = new URL(gameUrl).origin;
    } else {
      const ownerPort = await listenAvailable(app.ownerServer,'127.0.0.1',gamePort===65535 ? 0 : gamePort+1);
      localOrigin = `http://127.0.0.1:${ownerPort}`;
    }
    const url = localOrigin+'/';
    instance.publish({mode,url,...(remote && {publicUrl:remote.url + '/'})});
    console.log('Keep this window open while playing. Close it or press Ctrl+C to stop the server.');
    if (remote) {
      const route=values.internet?'funnel':'serve';
      console.log(`Owner access: ${url}`);
      console.log(`Player address: ${remote.url}/ (${route}, invitation required)`);
      tunnel = spawn(remote.command,[route,`--https=${remote.port}`,gameUrl],{stdio:'inherit',windowsHide:true});
      if (!values['no-browser']) openBrowser(url);
      const [code] = await once(tunnel,'exit');
      await close();
      if (code) process.exitCode = code;
    } else {
      console.log(`Lilium Moonlight ${url}`);
      for (const {name,address} of lanAddresses) {
        console.log(`${name} http://${address}:${gamePort}/ (invitation required)`);
      }
      if (!values['no-browser']) openBrowser(url);
    }
  } catch (error) {
    await close();
    throw error;
  }
}
