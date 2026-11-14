import { createReadStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { loadBase } from './base.mjs';
import { RequestError } from './errors.mjs';
import { createGame } from './game.mjs';
import { createChat } from './chat.mjs';
import { loadLodAssets, serveLodTile } from './lod-assets.mjs';
import { readCreativeCatalog } from './creative-catalog.mjs';
import { createPresence, readPose } from './presence.mjs';
import { MAX_PROFILE_BODY, profileChanges, publicProfile } from './presence-profile.mjs';
import { openStore } from './store.mjs';
import { createWorldTime } from './world-time.mjs';
import { modelFamilies, withExtractedModels } from '../world/extracted-models.mjs';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const COOKIE = 'honeymoon_guest';
const MAX_BODY = 4096;
const MAX_STREAMS = 64;
const MAX_WORLD_RESPONSES = 80;
const MAX_WORLD_CACHE_BYTES = 32 * 1024 * 1024;
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

function json(response, status, payload, headers = {}) {
  response.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(payload));
}

function acceptsGzip(header = '') {
  const qualities = new Map();
  for (const entry of header.toLowerCase().split(',')) {
    const [encoding, ...parameters] = entry.split(';').map(part => part.trim());
    const quality = parameters.find(part => part.startsWith('q='));
    const value = quality ? Number(quality.slice(2)) : 1;
    qualities.set(encoding, value >= 0 && value <= 1 ? value : 0);
  }
  return (qualities.get('gzip') ?? qualities.get('*') ?? 0) > 0;
}

function serveWorldJson() {
  const entries = new Map();
  let bytes = 0;
  return (request, response, key, load) => {
    const cached = entries.get(key);
    let entry = cached;
    if (!entry) {
      const data = load();
      if (!data) throw new RequestError(404, 'chunk_missing');
      const identity = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
      const gzip = gzipSync(identity, { level: 4 });
      entry = { identity, gzip, size: identity.length + gzip.length };
      if (entry.size <= MAX_WORLD_CACHE_BYTES) {
        while (entries.size >= MAX_WORLD_RESPONSES || bytes + entry.size > MAX_WORLD_CACHE_BYTES) {
          const [oldKey, oldest] = entries.entries().next().value;
          entries.delete(oldKey);
          bytes -= oldest.size;
        }
        entries.set(key, entry);
        bytes += entry.size;
      }
    } else {
      entries.delete(key);
      entries.set(key, entry);
    }
    const compressed = acceptsGzip(request.headers['accept-encoding']);
    const body = compressed ? entry.gzip : entry.identity;
    response.writeHead(200, {
      'Content-Type': MIME['.json'], 'Content-Length': body.length, Vary: 'Accept-Encoding',
      'Cache-Control': 'no-cache', ...(compressed && { 'Content-Encoding': 'gzip' }),
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  };
}

async function readBody(request, limit = MAX_BODY) {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError(415, 'expected_json');
  }
  if (Number(request.headers['content-length']) > limit) throw new RequestError(413, 'body_too_large');
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, 'body_too_large');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Expected an object');
    return result;
  } catch {
    throw new RequestError(400, 'invalid_json');
  }
}

function tokenFrom(request) {
  return request.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]+)(?:;|$)`))?.[1];
}

function requireSameOrigin(request, secure, allowedOrigin) {
  const origin = request.headers.origin;
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'origin_denied');
  if (origin && origin !== (allowedOrigin ?? `${secure ? 'https' : 'http'}://${request.headers.host}`)) {
    throw new RequestError(403, 'origin_denied');
  }
}

async function serveFile(request, response, path) {
  const type = MIME[extname(path)];
  if (!type) return false;
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile()) return false;
  response.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
  if (request.method === 'HEAD') response.end();
  else await pipeline(createReadStream(path), response);
  return true;
}

function staticPath(path, project, generated) {
  if (path === '/') return join(project, 'client', 'index.html');
  const vendor = path.match(/^\/vendor\/(?:three\/)?(three\.(?:module|core)\.js)$/);
  if (vendor) return join(project, 'node_modules', 'three', 'build', vendor[1]);
  const name = path.match(/^\/(?:client\/)?([a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:m?js|css|html|png|svg|webp))$/);
  if (name) return join(project, 'client', name[1]);
  const shared = path.match(/^\/world\/([a-zA-Z0-9][a-zA-Z0-9_.-]*\.mjs)$/);
  if (shared) return join(project, 'world', shared[1]);
  const atlas = path.match(/^\/generated\/textures\/([a-zA-Z0-9][a-zA-Z0-9_.-]*\.(?:json|png|webp))$/);
  if (atlas) return join(generated, 'textures', atlas[1]);
  const model = path.match(/^\/generated\/models\/([a-z]+)\.(json|png)$/);
  if (model && modelFamilies.includes(model[1])) return join(generated, 'models', `${model[1]}.${model[2]}`);
  const sound = path.match(/^\/generated\/sounds\/(sounds\.json|[a-f0-9]{24}\.(?:ogg|wav))$/);
  if (sound) return join(generated, 'sounds', sound[1]);
  return null;
}

export function createHoneymoonServer({
  project = PROJECT,
  generated = join(project, 'generated'),
  state = join(project, 'state', 'honeymoon.sqlite'),
  geometry,
  base = loadBase(join(generated, 'world')),
  secure = false,
  allowedOrigin,
  clock,
  afterCommit,
  allowRemoval,
} = {}) {
  const models = {};
  const creative = readCreativeCatalog(generated, project);
  const lod = base.manifest.chunkPalettes ? loadLodAssets(generated,base.hash) : null;
  const publicWorld = base.publicManifest ?? base.manifest;
  const manifest = lod ? {...publicWorld, lod:lod.descriptor} : publicWorld;
  const sounds = statSync(join(generated, 'sounds', 'sounds.json'), {throwIfNoEntry: false})?.isFile() ?? false;
  for (const family of modelFamilies) {
    try {
      const file = readFileSync(join(generated, 'models', `${family}.json`), 'utf8');
      statSync(join(generated, 'models', `${family}.png`));
      models[family] = JSON.parse(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (state !== ':memory:') mkdirSync(dirname(state), { recursive: true });
  const store = openStore(state);
  let game;
  try {
    game = createGame(base, store, withExtractedModels(geometry, models),
      { clock, allowRemoval, models, creativeBlocks:creative?.placeable, creativeItems:creative?.items });
  } catch (error) {
    store.close();
    throw error;
  }
  const streams = new Set();
  const worldTime = createWorldTime(store);
  const chat = createChat(entry => sendSocial('chat', entry));
  const presence = createPresence({ store, send: writeEvent, onVisibility(profile, online, player) {
    if (!online) game.leaveSeat(player);
    chat.playerStatus(profile, online);
  } });
  const serveWorld = serveWorldJson();
  const session = player => {
    const time = worldTime.snapshot();
    return { ...game.session(player), modelFamilies: Object.keys(models), sounds, dayTick: time.tick, time, creative:Boolean(creative),
      profile: publicProfile(player, store.getProfile(player)) };
  };

  function writeEvent(response, name, event, revision) {
    const id = revision === undefined ? '' : `id: ${revision}\n`;
    if (!response.write(`${id}event: ${name}\ndata: ${JSON.stringify(event)}\n\n`) && response.writableLength > 256 * 1024) {
      response.destroy();
    }
  }

  function sendSocial(name, data) {
    for (const stream of streams) if (stream.social) writeEvent(stream.response, name, data);
  }

  function broadcast(player, output) {
    for (const stream of streams) {
      const effects = player === stream.player ? [] : output.effects.filter(effect => effect.sound)
        .map(({message: _, ...effect}) => effect);
      if (output.changes.length || effects.length) {
        writeEvent(stream.response, 'commit', {
          ...output,
          effects,
        }, output.worldRevision);
      }
    }
    game.didCommit({ player, ...output });
  }

  async function dispatch(request, response) {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    const method = request.method;
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (path.startsWith('/api/')) {
      if (method === 'POST' || method === 'DELETE') requireSameOrigin(request, secure, allowedOrigin);
      const player = store.playerFromToken(tokenFrom(request));
      if (path === '/api/session' && method === 'POST') {
        await readBody(request);
        if (player) return json(response, 200, session(player));
        const newPlayer = store.createPlayer();
        const cookie = `${COOKIE}=${newPlayer.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure ? '; Secure' : ''}`;
        return json(response, 200, session(newPlayer.id), { 'Set-Cookie': cookie });
      }
      if (!player) throw new RequestError(401, 'session_required');
      if (path === '/api/chat' && method === 'POST') {
        const body = await readBody(request);
        return json(response, 200, chat.message(presence.onlineProfile(player), body));
      }
      if (path === '/api/time' && method === 'POST') {
        const body = await readBody(request);
        if (!presence.onlineProfile(player)) throw new RequestError(409, 'not_online');
        const time = worldTime.set(body);
        sendSocial('world-time', time);
        return json(response, 200, time);
      }
      if (path === '/api/profile' && method === 'POST') {
        const updates = await profileChanges(await readBody(request, MAX_PROFILE_BODY));
        const saved = store.getProfile(player);
        if (updates.nickname === saved?.nickname) delete updates.nickname;
        if (updates.skin !== undefined && (updates.skin?.hash ?? null) === (saved?.skinHash ?? null)) delete updates.skin;
        const different = updates.nickname !== undefined || updates.skin !== undefined;
        if (different) store.updateProfile(player, updates);
        const profile = publicProfile(player, different ? store.getProfile(player) : saved);
        if (different) presence.profile(player, profile);
        return json(response, 200, profile);
      }
      if (path === '/api/presence') {
        if (method === 'POST') {
          const pose = readPose(await readBody(request));
          const {position, seat} = game.session(player);
          presence.join(player, position, game.poseFor(player, pose));
          return json(response, 200, {ok:true, position, seat});
        }
        if (method === 'DELETE') {
          presence.leave(player);
          return json(response, 200, {ok: true});
        }
      }
      if (path === '/api/seat' && method === 'POST') {
        const body = await readBody(request);
        if (!presence.onlineProfile(player)) throw new RequestError(409, 'not_online');
        const pose = readPose(body);
        const result = game.sit(player, body.target, pose);
        presence.update(player, result.position, game.poseFor(player, {
          yaw:result.seat?.yaw ?? pose.yaw, pitch:result.seat ? 0 : pose.pitch, motion:'idle',
        }));
        return json(response, 200, result);
      }
      if (path === '/api/world' && method === 'GET') return json(response, 200, game.snapshot(player));
      if (path === '/api/position' && method === 'POST') {
        const body = await readBody(request);
        const pose = body.pose === undefined ? undefined : readPose(body.pose);
        const result = game.position(player, body);
        presence.update(player, result.position, game.poseFor(player, pose));
        if (result.changes.length || result.effects.length) broadcast(player, result);
        return json(response, 200, result);
      }
      if (path === '/api/respawn' && method === 'POST') {
        await readBody(request);
        const result = game.respawn(player);
        presence.update(player, result.position, {yaw:0, pitch:0, motion:'idle'});
        return json(response, 200, result);
      }
      if (path === '/api/action' && method === 'POST') {
        const result = game.action(player, await readBody(request));
        if (!result.replay && result.status === 200) {
          afterCommit?.(request, response, result.output);
          broadcast(player, result.output);
        }
        if (!response.destroyed) json(response, result.status, result.output);
        return;
      }
      if (path === '/api/events' && method === 'GET') {
        if (streams.size >= MAX_STREAMS) throw new RequestError(503, 'stream_limit');
        const presenceEntry = url.searchParams.get('presence') === '1' && presence.prepare(player);
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        });
        const stream = { player, response, social: url.searchParams.get('social') === '1' };
        streams.add(stream);
        game.touch(player);
        response.on('close', () => {
          streams.delete(stream);
          presence.disconnect(stream);
        });
        const cursor = request.headers['last-event-id'] ?? url.searchParams.get('since');
        const revision = game.worldRevision();
        const kind = cursor !== null && Number(cursor) !== revision ? 'reset' : 'ready';
        writeEvent(response, kind, { worldRevision: revision, contentHash: game.contentHash }, revision);
        if (presenceEntry) presence.connect(stream, presenceEntry);
        if (stream.social) {
          writeEvent(response, 'chat-history', {entries:chat.history()});
          writeEvent(response, 'world-time', worldTime.snapshot());
        }
        return;
      }
      throw new RequestError(404, 'not_found');
    }

    if (method !== 'GET' && method !== 'HEAD') throw new RequestError(405, 'method_not_allowed');
    if (creative && path === '/generated/creative/catalog.json') {
      return serveWorld(request, response, path, () => creative.catalog);
    }
    const skin = path.match(/^\/skins\/([a-f0-9]{64})\.png$/);
    if (skin) {
      const png = store.getSkin(skin[1]);
      if (!png) throw new RequestError(404, 'not_found');
      response.writeHead(200, { 'Content-Type': MIME['.png'], 'Content-Length': png.length,
        'Cache-Control': 'public, max-age=31536000, immutable' });
      response.end(method === 'HEAD' ? undefined : png);
      return;
    }
    if (path === '/generated/world/world.json') {
      return serveWorld(request, response, path, () => manifest);
    }
    if (path.startsWith('/generated/lod/')) {
      if (await serveLodTile(lod, request, response, path, acceptsGzip(request.headers['accept-encoding']))) return;
      throw new RequestError(404, 'not_found');
    }
    const chunk = path.match(/^\/generated\/world\/chunks\/(-?\d+)\.(-?\d+)\.json$/);
    if (chunk) {
      const x = Number(chunk[1]);
      const z = Number(chunk[2]);
      return serveWorld(request, response, `chunk:${x}.${z}`, () => base.publicChunk(x, z));
    }
    const terrain = path.match(/^\/generated\/world\/(terrain-(?:8|16|32)\.json)$/);
    if (terrain) {
      if (!base.manifest.terrain?.some(ring => ring.file === terrain[1])) throw new RequestError(404, 'not_found');
      return serveWorld(request, response, path, () => readFileSync(join(generated, 'world', terrain[1])));
    }
    const filename = staticPath(path, project, generated);
    if (!filename || !await serveFile(request, response, filename)) throw new RequestError(404, 'not_found');
  }

  const server = createServer({ requestTimeout: 15000 }, (request, response) => {
    dispatch(request, response).catch(error => {
      if (response.destroyed) return;
      if (response.headersSent) return response.destroy();
      if (error instanceof RequestError) return json(response, error.status, { error: error.code, ...error.details });
      console.error(error);
      return json(response, 500, { error: 'internal_error' });
    });
  });
  const heartbeat = setInterval(() => {
    for (const { player, response } of streams) {
      game.touch(player);
      if (!response.write(': heartbeat\n\n') && response.writableLength > 256 * 1024) response.destroy();
    }
  }, 15000);
  heartbeat.unref();
  const presenceTicks = setInterval(() => presence.flush(), 100);
  presenceTicks.unref();
  const blockTicks = setInterval(() => {
    try {
      const result = game.advance();
      if (result?.changes.length || result?.effects.length) broadcast(null, result);
    } catch (error) {
      console.error(error);
    }
  }, 50);
  blockTicks.unref();

  return {
    server,
    game,
    async close() {
      clearInterval(heartbeat);
      clearInterval(presenceTicks);
      clearInterval(blockTicks);
      for (const { response } of streams) response.end();
      await new Promise((success, fail) => {
        server.close(error => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') fail(error);
          else success();
        });
        server.closeAllConnections();
      });
      store.close();
    },
  };
}

async function main() {
  const geometry = await import('../world/geometry.mjs');
  const app = createHoneymoonServer({
    geometry,
    generated: process.env.HONEYMOON_GENERATED && resolve(process.env.HONEYMOON_GENERATED),
    state: process.env.HONEYMOON_STATE && resolve(process.env.HONEYMOON_STATE),
    secure: process.env.HONEYMOON_SECURE_COOKIE === '1',
    allowedOrigin: process.env.HONEYMOON_ORIGIN,
  });
  if (app.game.conflicts.length) console.log(JSON.stringify({ rebaseConflicts: app.game.conflicts }, null, 2));
  const host = process.env.HOST ?? '127.0.0.1';
  const port = Number(process.env.PORT ?? 4173);
  app.server.listen(port, host, () => console.log(`Honeymoon http://${host}:${app.server.address().port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
