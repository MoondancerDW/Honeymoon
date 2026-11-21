import { createHash, randomUUID } from 'node:crypto';
import { errorMonitor } from 'node:events';
import { createReadStream, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { loadBase } from './base.mjs';
import { RequestError } from './errors.mjs';
import { createGame } from './game.mjs';
import { createChat } from './chat.mjs';
import { createAdminCommands } from './admin-commands.mjs';
import { connectionReport, createLoadLog, networkPlayerTag } from './load-log.mjs';
import { startNetworkProbe } from './network-probe.mjs';
import {diagnosticPagePattern,diagnosticTracePattern,loadPlayerDiagnostics,parsePlayerDiagnostics,
  playerDiagnosticsBodyLimit} from './player-diagnostics.mjs';
import {loadLodAssets,loadVistaAssets,serveClimateMap,serveLodTile,serveVistaTile} from './lod-assets.mjs';
import { createTerrainPreload } from './terrain-prefetch.mjs';
import { readCreativeCatalog } from './creative-catalog.mjs';
import { createPresence, readPose } from './presence.mjs';
import { MAX_PROFILE_BODY, profileChanges, publicProfile, savedSkinTraits } from './presence-profile.mjs';
import { openStore } from './store.mjs';
import { createWorldTime } from './world-time.mjs';
import { createWarps } from './warps.mjs';
import { createNpcs } from './npcs.mjs';
import { createWorldEdit } from './world-edit.mjs';
import { createSurvival } from './survival.mjs';
import {accessCookie,createAccess,legacyClearCookie,legacyCookieName,readAccessCookie} from './access.mjs';
import { modelFamilies, withExtractedModels } from '../world/extracted-models.mjs';
import {ponyAbilities,ponyMaxHealth} from '../world/pony-abilities.mjs';
import { readBuildNumber } from './build-version.mjs';
import { openLocalJournal } from './local-journal.mjs';
import { loadSoloDistribution } from './solo-distribution.mjs';
import { soloRegionFile } from './solo-assets.mjs';
import { isMovementPage } from './movement-channel.mjs';
import { createTestRange } from './test-range.mjs';
import { createTestRangeNpc } from './test-range-npc.mjs';

const PROJECT = fileURLToPath(new URL('..', import.meta.url));
const MAX_BODY = 4096;
const MAX_MOVEMENT_BODY = 6144;
const MAX_CHAT_BODY = 8192;
const MAX_ACTION_BODY = 16384;
const MAX_NPC_EDITOR_BODY = 4 * 1024 * 1024;
const MAX_STREAMS = 64;
const MAX_PROFILE_STREAMS = 3;
const parallelDeviceRoutes=new Set(['/api/profile','/api/time','/api/weather','/api/modes','/api/npcs/editor']);
const ponyRaces=new Set(['earth','pegasus','unicorn','alicorn']);
const ponySizes=new Set(['normal','small','large','tall']);
const MAX_STREAM_BACKLOG = 256 * 1024;
const MAX_BULK_COMMIT = 3 * 1024 * 1024;
const MAX_WORLD_RESPONSES = 224;
const MAX_WORLD_CACHE_BYTES = 48 * 1024 * 1024;
// Bump when the public chunk format or server-side projection changes.
const CHUNK_CACHE_FORMAT = 2;
const gzipWorld = promisify(gzip);
const privateNpcFiles = new Set(['original.json']);
const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
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
  const pending = new Map();
  let bytes = 0;

  async function loadEntry(key, load, revalidate) {
    const data = load();
    if (!data) throw new RequestError(404, 'chunk_missing');
    const identity = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
    const compressed = await gzipWorld(identity, {level:1});
    const etag = revalidate ? `W/"${createHash('sha256').update(identity).digest('hex')}"` : undefined;
    const entry = {identity, compressed, etag, size:identity.length+compressed.length};
    if (entry.size <= MAX_WORLD_CACHE_BYTES) {
      while (entries.size >= MAX_WORLD_RESPONSES || bytes + entry.size > MAX_WORLD_CACHE_BYTES) {
        const [oldKey, oldest] = entries.entries().next().value;
        entries.delete(oldKey);
        bytes -= oldest.size;
      }
      entries.set(key,entry);
      bytes += entry.size;
    }
    return entry;
  }

  return async (request, response, key, load, cacheControl) => {
    let entry = entries.get(key);
    if (entry) {
      entries.delete(key);
      entries.set(key, entry);
    } else {
      if (!pending.has(key)) pending.set(key,loadEntry(key,load,!cacheControl&&!key.startsWith('chunk:')).finally(()=>pending.delete(key)));
      entry = await pending.get(key);
    }
    if (response.destroyed) return;
    const compressed = acceptsGzip(request.headers['accept-encoding']);
    const body = compressed ? entry.compressed : entry.identity;
    const authenticated=response.getHeader('Vary')==='Cookie';
    const headers = {
      'Content-Type': MIME['.json'], Vary:authenticated?'Cookie, Accept-Encoding':'Accept-Encoding',
      'Cache-Control':cacheControl ?? (authenticated?'private, no-cache':'no-cache'),
      ...(entry.etag && {ETag:entry.etag}),
      ...(compressed && { 'Content-Encoding': 'gzip' }),
    };
    if (entry.etag && matchesEtag(request,entry.etag)) {
      response.writeHead(304,headers);
      response.end();
      return;
    }
    response.writeHead(200, {...headers,'Content-Length':body.length});
    response.end(request.method === 'HEAD' ? undefined : body);
  };
}

async function serveAudioRecording(request,response,path,{type=MIME['.ogg'],cacheControl,
  file=statSync(path,{throwIfNoEntry:false})}={}) {
  if (!file?.isFile()) throw new RequestError(404,'not_found');
  const requested=request.headers.range;
  const headers={'Content-Type':type,'Accept-Ranges':'bytes',
    'Cache-Control':cacheControl ?? (response.getHeader('Vary')==='Cookie'?'private, max-age=3600':'public, max-age=3600')};
  let start=0,end=file.size-1;
  if (requested) {
    const range=/^bytes=(\d*)-(\d*)$/.exec(requested);
    if (range?.[1]) {
      start=Number(range[1]);
      if (range[2]) end=Math.min(end,Number(range[2]));
    } else if (range?.[2]) start=Math.max(0,file.size-Number(range[2]));
    else start=file.size;
    if (start>end || start>=file.size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      response.writeHead(416,{...headers,'Content-Range':`bytes */${file.size}`});
      response.end();
      return;
    }
    headers['Content-Range']=`bytes ${start}-${end}/${file.size}`;
  }
  response.writeHead(requested?206:200,{...headers,'Content-Length':end-start+1});
  if (request.method==='HEAD') response.end();
  else await pipeline(createReadStream(path,{start,end}),response);
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

function isLoopback(address) {
  return address==='127.0.0.1' || address==='::1' || address==='::ffff:127.0.0.1';
}

function ownerRequest(request,address) {
  if (!address || !isLoopback(address.address) || !isLoopback(request.socket.remoteAddress)) return false;
  const host=/^(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d+))?$/i.exec(request.headers.host??'');
  return Boolean(host && Number(host[1]??80)===address.port);
}

function requireSameOrigin(request, secure, allowedOrigin) {
  const origin = request.headers.origin;
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, 'origin_denied');
  if (origin && origin !== (allowedOrigin ?? `${secure ? 'https' : 'http'}://${request.headers.host}`)) {
    throw new RequestError(403, 'origin_denied');
  }
}

function matchesEtag(request,etag) {
  return request.headers['if-none-match']?.split(',').some(value => {
    const candidate=value.trim();
    return candidate==='*' || candidate===etag || candidate===etag.slice(2);
  });
}

async function serveFile(request, response, path) {
  const type = MIME[extname(path)];
  if (!type) return false;
  const stat = statSync(path, { bigint:true, throwIfNoEntry:false });
  if (!stat?.isFile()) return false;
  const identity = [resolve(path), stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join('\0');
  const etag = `W/"${createHash('sha256').update(identity).digest('hex')}"`;
  const headers = { 'Content-Type':type, ETag:etag,
    'Cache-Control':response.getHeader('Vary')==='Cookie' ? 'private, no-cache' : 'no-cache' };
  if (matchesEtag(request,etag)) {
    response.writeHead(304, headers);
    response.end();
    return true;
  }
  response.writeHead(200, { ...headers, 'Content-Length':stat.size.toString() });
  if (request.method === 'HEAD') response.end();
  else await pipeline(createReadStream(path), response);
  return true;
}

function staticPath(path, project, generated) {
  if (path === '/') return join(project, 'client', 'index.html');
  if (path === '/honeymoon.webmanifest') return join(project, 'client', 'honeymoon.webmanifest');
  if (path === '/generated/weather/biomes.json') return join(generated, 'weather', 'biomes.json');
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
  soloCache,
  geometry,
  base = loadBase(join(generated, 'world'),{partial:soloCache}),
  secure = false,
  allowedOrigin,
  comparisonOrigin,
  publicOrigin = allowedOrigin,
  inviteRequired = secure,
  singlePlayer = false,
  altitudeMusic = process.env.HONEYMOON_ALTITUDE_TRACK,
  monitorNetwork = false,
  soloWorld,
  switchSoloWorld,
  ownerOnPrimary = !inviteRequired && !secure,
  npcAdminKey,
  clock,
  afterCommit,
  allowRemoval = true,
  initialMode,
} = {}) {
  if (singlePlayer && (secure || inviteRequired)) throw new Error('Single-player requires a local server');
  if (soloCache && !singlePlayer) throw new Error('A streamed solo cache requires single-player mode');
  if ((soloWorld !== undefined || switchSoloWorld !== undefined) &&
      (!singlePlayer || !['equestria','test-range'].includes(soloWorld) || typeof switchSoloWorld !== 'function')) {
    throw new Error('A local world switch requires a single-player destination');
  }
  const testRange=soloWorld==='test-range';
  const streamedWorld=soloCache && !testRange;
  const persistSoloPosition=singlePlayer && Boolean(soloCache || soloWorld);
  const altitudeTrack=(inviteRequired || singlePlayer) && typeof altitudeMusic==='string' &&
    extname(altitudeMusic).toLowerCase()==='.mp3' ? resolve(altitudeMusic) : undefined;
  function altitudeTrackFile() {
    if (!altitudeTrack) return;
    try {
      const file=statSync(altitudeTrack,{throwIfNoEntry:false});
      if (file?.isFile() && file.size>0) return file;
    } catch {
      // A local music configuration may point to an unavailable drive.
    }
  }
  const build = readBuildNumber(project);
  let soloDistribution;
  if (!singlePlayer) {
    try { soloDistribution=loadSoloDistribution(generated); }
    catch (error) { console.error('Lilium Moonlight solo download index:',error.message); }
  }
  const localJournal=singlePlayer ? openLocalJournal(state) : undefined;
  const models = {};
  const sounds = statSync(join(generated, 'sounds', 'sounds.json'), {throwIfNoEntry: false})?.isFile() ?? false;
  const boatTexture = statSync(join(generated,'textures','boat.png'),{throwIfNoEntry:false})?.isFile() ?? false;
  for (const family of modelFamilies) {
    try {
      const file = readFileSync(join(generated, 'models', `${family}.json`), 'utf8');
      statSync(join(generated, 'models', `${family}.png`));
      models[family] = JSON.parse(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const creative = readCreativeCatalog(generated, project, models.biblio?.flatItems);
  if (testRange) base=createTestRange({...creative,blockStates:base.catalog});
  const testNpcSource=testRange ? createTestRangeNpc(base) : undefined;
  const lod = !testRange && base.manifest.chunkPalettes ? loadLodAssets(generated,base.hash) : null;
  const vista = lod ? loadVistaAssets(generated) : null;
  const terrainPreload = !singlePlayer && createTerrainPreload(lod,vista);
  const publicWorld = base.publicManifest ?? base.manifest;
  const chunkCacheVersion = createHash('sha256').update(JSON.stringify([
    CHUNK_CACHE_FORMAT, base.hash, publicWorld.fullChunks?.hash,
  ])).digest('hex');
  const manifest = {...publicWorld, chunkCacheVersion, ...(lod && {lod:lod.descriptor}), ...(vista && {vista:vista.descriptor})};
  if (state !== ':memory:') mkdirSync(dirname(state), { recursive: true });
  const store = openStore(state);
  const savedTraits = new Map();
  function rememberTraits(player,{size:skinSize,ponyType:skinPonyType}) {
    if (!savedTraits.has(player) && savedTraits.size >= 512) savedTraits.delete(savedTraits.keys().next().value);
    const overrides=store.getPonyTraits(player);
    const traits={skinSize,skinPonyType,size:overrides.sizeOverride??skinSize,ponyType:overrides.raceOverride??skinPonyType,...overrides};
    savedTraits.set(player,traits);
    return traits;
  }
  function playerTraits(player, saved) {
    if (savedTraits.has(player)) return savedTraits.get(player);
    saved ??= store.getProfile(player);
    return rememberTraits(player,savedSkinTraits(saved?.skinHash && store.getSkin(saved.skinHash)));
  }
  const playerSize=(player,saved)=>playerTraits(player,saved).size;
  const playerPonyType=player=>playerTraits(player).ponyType;
  const survival=createSurvival(store,initialMode,{now:clock,healthLimit:player=>{
    const {ponyType,size}=playerTraits(player);
    return ponyMaxHealth(ponyType,size);
  }});
  function profileFor(player, saved = store.getProfile(player)) {
    const {size,ponyType,raceOverride,sizeOverride,raceRevision}=playerTraits(player,saved);
    return {...publicProfile(player,saved,size,ponyType),raceOverride,sizeOverride,raceRevision};
  }
  function avatarProfile(profile) {
    const {raceOverride,sizeOverride,raceRevision,...avatar}=profile;
    return avatar;
  }
  let game;
  try {
    game = createGame(base, store, withExtractedModels(geometry, models),
      {clock, allowRemoval, models, creativeBlocks:creative?.placeable, creativeItems:creative?.items, playerSize,playerPonyType,
        survival,survivalChanged,persistPositions:!singlePlayer&&state!==':memory:'});
  } catch (error) {
    store.close();
    throw error;
  }
  const streams = new Set();
  const playerDiagnostics=singlePlayer ? undefined : loadPlayerDiagnostics(state);
  const loadLog=singlePlayer || state===':memory:' ? undefined : createLoadLog({
    directory:join(dirname(state),'load-logs'),onlineStreams:()=>streams.size,studyUntil:playerDiagnostics?.until,
  });
  const access=createAccess(store,{inviteRequired,singlePlayer,ownerKey:npcAdminKey,publicOrigin,now:clock,
    revokeStream:device=>{
      for (const stream of streams) if (stream.deviceId===device) {
        loadLog?.endStream(stream.response,'access_revoked');
        writeEvent(stream.response,'access-revoked',{});
        stream.response.end();
      }
    },disconnectProfile:(player,ban)=>{
      for (const stream of streams) if (stream.player===player&&!stream.response.writableEnded) {
        loadLog?.endStream(stream.response,'profile_banned');
        writeEvent(stream.response,'access-revoked',{banned:true,reason:ban.reason});
        stream.response.end();
      }
      presence.leave(player);
    }});
  const bulkWrites=new WeakMap();
  const worldTime = createWorldTime(store,clock);
  const warps = createWarps(store);
  const chat = createChat({
    store,now:clock,isAdmin:access.isAdmin,logDirectory:state===':memory:'?undefined:join(dirname(state),'chat-logs'),
    publish: (entry, audience) => sendSocial('chat', entry, (player, stream) =>
      !audience || audience.includes(player) && stream.presence),
    recipients(origin) {
      return [...streams].filter(({player, social, presence: sharesPresence, response}) => {
        if (!social || !sharesPresence || response.writableEnded || response.destroyed) return false;
        const point = presence.onlinePosition(player);
        return point && Math.hypot(point.x - origin.x, point.y - origin.y, point.z - origin.z) <= 18;
      }).map(({player}) => player);
    },
  });
  const presence = createPresence({store,profileFor:player=>avatarProfile(profileFor(player)),send:writeEvent,
    canSeeSpectators:access.isAdmin,onVisibility(profile,online,player,spectator) {
    loadLog?.player(player,online);
    if (!online) {
      game.leaveSeat(player);
      game.clearLavaContact(player);
      npcs.leave(player);
    }
    try { if (!spectator) chat.playerStatus(profile,online,player); }
    catch (error) { console.error(error); }
  } });
  const npcs=createNpcs({generated,store,creativeBlocks:creative?.placeable,creativeItems:creative?.items,
    editorAuth:access.npcEditor,base,game,worldTime,profile:profileFor,now:clock,
    source:testNpcSource,
    teleportPlayer:streamedWorld ? async (player,target,cancelled)=>{
      await ensureSoloArea(target);
      if (cancelled?.()) throw new RequestError(499,'request_closed');
      return teleportPlayer(player,target);
    } : teleportPlayer,
    damagePlayer:(player,amount,npc)=>game.damageFromNpc?.(player,amount,npc),
    healPlayer:player=>game.healFromNpc?.(player)});
  if (soloCache) {
    for (const path of Object.keys(soloCache.manifest.files)) {
      const match=/^npcs\/sound\/([^/]+\.ogg)$/i.exec(path);
      if (match) npcs.sounds.add(match[1]);
    }
  }
  const worldEdit=createWorldEdit({game:game.worldEdit,isAdmin:npcs.isAdmin,isCreative:player=>!survival.isGame(player)});
  const serveWorld = serveWorldJson();
  let soloPlayer, lastSavedSoloPosition, restoredSolo=false;

  async function ensureSoloFile(path,priority=5) {
    if (!soloCache || !path || !Object.hasOwn(soloCache.manifest.files,path)) return;
    try { await soloCache.ensure(path,{priority}); }
    catch { throw new RequestError(503,'solo_asset_unavailable'); }
  }

  async function ensureSoloArea(target) {
    if (!streamedWorld || !Number.isFinite(target?.x) || !Number.isFinite(target?.z)) return;
    const cx=Math.floor(target.x/16), cz=Math.floor(target.z/16);
    const files=new Set();
    for (let dz=-2;dz<=2;dz++) for (let dx=-2;dx<=2;dx++) {
      if (base.worldCoverage?.(cx+dx,cz+dz)) files.add(soloRegionFile(cx+dx,cz+dz));
    }
    await Promise.all([...files].map(path=>ensureSoloFile(path,20)));
  }

  function saveSoloPosition() {
    if (!soloPlayer || survival.dead(soloPlayer)) return;
    const {position}=game.session(soloPlayer);
    if (position && !['x','y','z'].every(axis=>position[axis]===lastSavedSoloPosition?.[axis]) &&
        base.hasPlayableChunk(Math.floor(position.x/16),Math.floor(position.z/16))) {
      store.putState('single-player',soloPlayer,'position',1,position);
      lastSavedSoloPosition={...position};
    }
  }

  function restoreSoloPosition(player) {
    if (!persistSoloPosition || restoredSolo) return;
    restoredSolo=true;
    soloPlayer=player;
    const saved=store.getState('single-player',player,'position')?.value;
    if (!saved || ![saved.x,saved.y,saved.z].every(Number.isFinite) || survival.dead(player)) return;
    lastSavedSoloPosition=saved;
    try { game.teleport(player,saved); }
    catch (error) { if (!(error instanceof RequestError)) throw error; }
  }
  const activeElsewhere=credential=>inviteRequired && Boolean(credential?.deviceId) &&
    [...streams].some(stream=>stream.player===credential.uid && stream.presence &&
      stream.deviceId!==credential.deviceId && !stream.response.destroyed && !stream.response.writableEnded);
  function accessView(credential,owner) {
    return {...access.view(credential,owner),...(activeElsewhere(credential)&&{activeElsewhere:true})};
  }
  const session = (credential, owner) => {
    const player=credential.uid;
    const diagnostics=playerDiagnostics?.session(player);
    const time = worldTime.snapshot();
    const weatherSettings=worldTime.weatherSettings();
    return { ...game.session(player), modelFamilies:Object.keys(models),sounds,boatTexture,dayTick:time.tick,time,
      weather:weatherSettings.mode,weatherSettings,creative:Boolean(creative),
      ...(altitudeTrackFile() && {altitudeMusic:'/api/altitude-music'}),
      ...(survival.enabled&&{gameMode:playerMode(player)}),...(diagnostics&&{playerDiagnostics:diagnostics}),
      ...(streamedWorld&&{soloDownload:true}),...(soloWorld&&{soloWorld}),
      profile:profileFor(player),nightVision:store.getNightVision(player),access:accessView(credential,owner) };
  };

  function sendStudyHeartbeat(stream) {
    if (!stream.studyId || !playerDiagnostics?.active(stream.player)) return;
    const at=Date.now();
    writeEvent(stream.response,'diagnostics-heartbeat',{at,streamId:stream.studyId});
    loadLog?.studyHeartbeat(stream.deviceId,stream.studyId,stream.studyPage,at);
  }

  function playerMode(player) {
    const {flight,flightAllowed}=game.abilityState(player);
    return {...survival.status(player),admin:npcs.isAdmin(player),spectator:game.isSpectator(player),flight,flightAllowed};
  }

  function raceSnapshot(player,profile=profileFor(player)) {
    const {size,skin,ponyType,raceOverride,sizeOverride,raceRevision}=profile;
    const {position,stance,seat,flight,flightAllowed,jumpCharge,magicCooldownMs}=game.session(player);
    return {uid:player,size,skin,ponyType,raceOverride,sizeOverride,raceRevision,position,stance,seat,
      flight,flightAllowed,jumpCharge,magicCooldownMs,...(survival.enabled&&{gameMode:playerMode(player)})};
  }

  function prepareRaceDrop(player,previousRace,nextRace) {
    if (ponyAbilities(previousRace).horn && !ponyAbilities(nextRace).horn) {
      return game.prepareOffhandDrop(player,presence.heading(player));
    }
  }

  function reconcilePonyTraits(player,previous,traits,drop) {
    if (drop) {
      drop.publish();
      broadcastDroppedItems(true);
    }
    if (traits.ponyType!==previous.ponyType) game.reconcileRace(player);
    if (traits.size!==previous.size) return game.reconcileProfile(player);
  }

  function publishProfileSetting(player,event,snapshot) {
    for (const stream of streams) if (stream.player===player && stream.presence) {
      writeEvent(stream.response,event,snapshot);
    }
  }

  function setNightVision(player,enabled,initialize=false) {
    if (typeof enabled!=='boolean' || typeof initialize!=='boolean') throw new RequestError(400,'invalid_night_vision');
    const {setting,changed}=store.setNightVision(player,enabled,initialize);
    const snapshot={uid:player,...setting};
    if (changed) publishProfileSetting(player,'profile-night-vision',snapshot);
    return snapshot;
  }

  function survivalChanged(player,state) {
    const {flight,flightAllowed}=game.abilityState(player);
    sendSocial('game-mode',{...state,admin:npcs.isAdmin(player),flight,flightAllowed},id=>id===player);
    const position=presence.onlinePosition(player);
    if (position) presence.update(player,game.session(player).position,{death:survival.avatarDeath(player)});
    if (state.death && !game.isSpectator(player)) chat.playerDeath(profileFor(player),state.death.cause,player);
  }

  function modeAdministration() {
    if (inviteRequired) return {mode:survival.defaultMode(),players:access.profiles().map(({uid,nickname,profileName})=>({
      id:uid,uid,nickname:nickname??profileName,profileName,online:Boolean(presence.onlineProfile(uid)),
      mode:survival.mode(uid),override:survival.override(uid),spectator:game.isSpectator(uid),
    }))};
    const players=[...new Set([...streams].map(stream=>stream.player))].flatMap(player=>{
      const profile=presence.onlineProfile(player);
      return profile ? [{id:profile.id,nickname:profile.nickname,mode:survival.mode(player),override:survival.override(player)}] : [];
    });
    return {mode:survival.defaultMode(),players};
  }

  function writeEvent(response, name, event, revision) {
    if (response.writableEnded || response.destroyed) return;
    const id = revision === undefined ? '' : `id: ${revision}\n`;
    const packet=`${id}event: ${name}\ndata: ${JSON.stringify(event)}\n\n`;
    const bytes=name==='commit'?Buffer.byteLength(packet):0;
    if (bytes>MAX_STREAM_BACKLOG) {
      // Keep one bounded region commit intact so reconnect never sees half of a revision.
      if (bytes>MAX_BULK_COMMIT || bulkWrites.has(response) || response.writableLength>MAX_STREAM_BACKLOG) {
        return writeEvent(response,'reset',{worldRevision:revision,contentHash:game.contentHash},revision);
      }
      if (response.destroyed || response.write(packet)) return;
      bulkWrites.set(response,bytes);
      response.once('drain',()=>bulkWrites.delete(response));
      if (response.writableLength>MAX_STREAM_BACKLOG+bytes) destroyStream(response,'backpressure');
      return;
    }
    writeStream(response,packet);
  }

  function writeStream(response,packet) {
    if (!response.writableEnded && !response.destroyed && !response.write(packet) &&
        response.writableLength>MAX_STREAM_BACKLOG+(bulkWrites.get(response)??0)) destroyStream(response,'backpressure');
  }

  function destroyStream(response,reason) {
    loadLog?.endStream(response,reason);
    response.destroy();
  }

  function sendSocial(name, data, receives = () => true) {
    for (const stream of streams) if (stream.social && receives(stream.player,stream)) writeEvent(stream.response, name, data);
  }

  function sendChatHistory({player,response}) {
    const through = chat.latestId();
    const limit = 32;
    let after = 0;
    function replay() {
      try {
        while (!response.writableEnded && !response.destroyed) {
          if (response.writableNeedDrain) {
            response.once('drain',replay);
            return;
          }
          const snapshot = chat.snapshot(player,{after,through,limit});
          const {entries} = snapshot;
          if (entries.length || after === 0) writeEvent(response,'chat-history',snapshot);
          if (entries.length < limit) return;
          after = entries.at(-1).id;
          if (after >= through) return;
        }
      } catch (error) {
        console.error(error);
        destroyStream(response,'chat_history_error');
      }
    }
    replay();
  }

  function publishTeleport(player,result,yaw=0,pitch=0) {
    presence.update(player,result.position,game.poseFor(player,{yaw,pitch,motion:'idle'}));
    if (result.changes.length || result.effects.length) broadcast(player,result);
    return result;
  }

  function teleportPlayer(player,target) {
    return publishTeleport(player,game.teleport(player,target));
  }

  function adminTeleport(actor,uid,anchor) {
    if (!access.isAdmin(actor)) throw new RequestError(403,'admin_required');
    if (uid===anchor) throw new RequestError(400,'admin_target_self');
    if (uid!==actor) access.adminTarget(actor,uid,true);
    if (!presence.onlinePosition(actor) || !presence.onlinePosition(uid) || !presence.onlinePosition(anchor)) {
      throw new RequestError(409,'not_online');
    }
    const teleport={...publishTeleport(uid,game.teleportNear(uid,anchor)),teleportId:randomUUID()};
    publishProfileSetting(uid,'admin-teleport',teleport);
    return {uid,teleport};
  }

  const spectatorRevisions=new Map();
  let spectatorRevision=0;
  function spectatorSnapshot(player) {
    const {position,seat,stance,spectator,flight,flightAllowed}=game.session(player);
    return {uid:player,position,seat,stance,spectator,flight,flightAllowed,
      spectatorRevision:spectatorRevisions.get(player)??0};
  }

  function setPlayerSpectator(player,enabled,pose) {
    const previous=game.isSpectator(player);
    const result=game.setSpectator(player,{enabled});
    if (result.spectator!==previous) {
      spectatorRevision=Math.max(Date.now(),spectatorRevision+1);
      spectatorRevisions.set(player,spectatorRevision);
      presence.update(player,result.position,{...game.poseFor(player,pose),spectator:result.spectator});
      presence.flush();
      publishProfileSetting(player,'profile-spectator',{uid:player,...result,spectatorRevision});
      sendSocial('game-mode',playerMode(player),candidate=>candidate===player);
    }
    return {uid:player,...result,spectatorRevision:spectatorRevisions.get(player)??0};
  }

  function changePlayerMode(member,mode) {
    survival.setMode(member,mode);
    const observing=member && game.isSpectator(member) ? setPlayerSpectator(member,false) : undefined;
    for (const id of member?[member]:new Set([...streams].map(stream=>stream.player))) {
      if (!survival.isGame(id)) game.clearLavaContact(id);
      if (!survival.isGame(id)&&survival.status(id).death) survival.reset(id);
      game.reconcileFlight(id);
      sendSocial('game-mode',playerMode(id),recipient=>recipient===id);
      const position=presence.onlinePosition(id);
      if (position) presence.update(id,game.session(id).position,{death:survival.avatarDeath(id)});
    }
    return member ? {uid:member,gameMode:playerMode(member),...(observing&&{observing})} : {};
  }

  function updateWorldTime(body) {
    const value=worldTime.set(body);
    sendSocial('world-time',value);
    return value;
  }

  function updateWorldWeather(body) {
    const previous=worldTime.weatherSettings();
    const value=worldTime.setWeather(body);
    if (value.mode!==previous.mode || value.dynamic!==previous.dynamic || value.nextChangeAt!==previous.nextChangeAt) {
      sendSocial('weather',value);
    }
    return value;
  }

  const adminCommands=createAdminCommands({
    isAdmin:access.isAdmin,profiles:access.profiles,teleport:adminTeleport,
    toggleSpectator(actor,target) {
      if (target!==actor) access.adminTarget(actor,target,true);
      if (!presence.onlinePosition(target)) throw new RequestError(409,'not_online');
      return setPlayerSpectator(target,!game.isSpectator(target));
    },
    toggleCreative(actor,target) {
      if (target!==actor) access.adminTarget(actor,target,true);
      return changePlayerMode(target,survival.isGame(target)?'creative':'game');
    },
    setTime:updateWorldTime,getWeather:worldTime.weather,setWeather:updateWorldWeather,
  });

  function sendNpcs(stream) {
    if (!stream.npcs || stream.response.writableLength>64*1024) return;
    const snapshot=npcs.snapshot(stream.player);
    const updates=[];
    const next=new Map();
    let rosterChanged=!stream.npcRows || snapshot.npcs.length!==stream.npcRows.size ||
      snapshot.editor!==stream.npcAdmin;
    for (const npc of snapshot.npcs) {
      const {id,position,yaw,headYaw,pitch,spinSpeed,animation,moving,health,line,revision}=npc;
      const motion={id,position,yaw,headYaw,pitch,spinSpeed,animation,moving,health,line:line??null};
      const entry={base:revision,motion:JSON.stringify(motion)};
      const previous=stream.npcRows?.get(id);
      if (previous?.base!==entry.base) rosterChanged=true;
      else if (previous.motion!==entry.motion) updates.push(motion);
      next.set(id,entry);
    }
    stream.npcRows=next;
    stream.npcAdmin=snapshot.editor;
    if (rosterChanged) writeEvent(stream.response,'npcs',snapshot);
    else if (updates.length) writeEvent(stream.response,'npc-motion',{updates});
  }

  function broadcast(player, output) {
    const {inventory: _,container:_container,...publicOutput} = output;
    for (const stream of streams) {
      const effects = player === stream.player ? [] : output.effects.filter(effect => effect.sound)
        .map(({message: _, ...effect}) => effect);
      if (output.changes.length || effects.length || output.frames) {
        writeEvent(stream.response, 'commit', {
          ...publicOutput,
          effects,
        }, output.worldRevision);
      }
    }
    game.didCommit({ player, ...output });
  }

  function broadcastMinecarts() {
    for (const {player,response,minecarts} of streams) {
      if (minecarts) writeEvent(response,'minecarts',game.minecartSnapshot(player));
    }
  }

  function sendDroppedItems(stream, force) {
    if (!stream.droppedItems) return;
    const view = game.droppedItemView(stream.player);
    if (!force && view === stream.droppedItemView) return;
    stream.droppedItemView = view;
    writeEvent(stream.response,'dropped-items',{entities:game.droppedItemSnapshot(stream.player)});
  }

  function broadcastDroppedItems(force) {
    for (const stream of streams) sendDroppedItems(stream,force);
  }

  async function dispatch(request, response, owner, requestSecure, requestOrigin) {
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    loadLog?.request(path,response);
    const method = request.method;
    const isApi=path.startsWith('/api/');
    const gameAsset=path.startsWith('/generated/') || path.startsWith('/skins/');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (soloCache) requireSameOrigin(request,false);
    if (path.startsWith('/solo-download/')) {
      if (soloDistribution && await soloDistribution.serve(request,response,path)) return;
      throw new RequestError(404,'not_found');
    }
    if (path==='/api/ping' && (method==='GET'||method==='HEAD')) {
      const trace=request.headers['x-honeymoon-trace'];
      if (playerDiagnostics && typeof trace==='string' && diagnosticTracePattern.test(trace)) {
        const browser=access.authenticate(readAccessCookie(request));
        if (browser && playerDiagnostics.active(browser.uid)) loadLog?.studyRequest(path,response,browser.deviceId,trace,browser.uid);
      }
      response.writeHead(204,{'Cache-Control':'no-store','X-Honeymoon-Server-Time':String(Date.now())});
      response.end();
      return;
    }
    if (path==='/api/build' && (method==='GET'||method==='HEAD')) return json(response,200,{build});
    const credential=isApi||inviteRequired&&gameAsset ? access.authenticate(readAccessCookie(request)) : undefined;
    const studying=credential && playerDiagnostics?.active(credential.uid);
    if (studying) loadLog?.studyRequest(path,response,credential.deviceId,request.headers['x-honeymoon-trace'],credential.uid);
    if (isApi) {
      if (method === 'POST' || method === 'DELETE') requireSameOrigin(request,requestSecure,requestOrigin);
      if (singlePlayer && (path.startsWith('/api/access/') || path==='/api/chat')) {
        throw new RequestError(404,'not_found');
      }
      if (streamedWorld && path==='/api/solo-cache' && method==='GET') {
        return json(response,200,{...soloCache.status(),build});
      }
      if (streamedWorld && method==='POST' && path==='/api/solo-cache/download-all') {
        void soloCache.downloadAll().catch(()=>{});
        return json(response,202,{ok:true});
      }
      if (streamedWorld && method==='POST' && path==='/api/solo-cache/cancel') {
        soloCache.cancelDownloadAll();
        return json(response,200,{ok:true});
      }
      if (singlePlayer && path==='/api/local-diagnostics') {
        if (method==='GET') return json(response,200,localJournal?.read()??[],{
          'Content-Disposition':'attachment; filename="Lilium-Moonlight-diagnostics.json"',
        });
        if (method==='POST') {
          const {kind,position,mesh,chunks,lastChunk,message}=await readBody(request);
          if (!['heartbeat','exit','browser-error','worker-error','webgl-lost','webgl-restored'].includes(kind)) {
            throw new RequestError(400,'invalid_diagnostic');
          }
          const validPosition=Array.isArray(position) && position.length===3 && position.every(Number.isFinite);
          const validChunk=Array.isArray(lastChunk) && lastChunk.length===3 &&
            lastChunk.slice(0,2).every(Number.isSafeInteger) && typeof lastChunk[2]==='boolean';
          localJournal?.record({kind,build,...(validPosition&&{position}),
            ...(Number.isSafeInteger(mesh)&&{mesh}),...(Number.isSafeInteger(chunks)&&{chunks}),
            ...(validChunk&&{lastChunk}),
            ...(typeof message==='string'&&{message:message.slice(0,260)})});
          return json(response,200,{ok:true});
        }
      }
      const player=credential?.uid;
      const ownerBootstrap=method==='POST'&&owner&&(path==='/api/access/owner'||path==='/api/npcs/admin');
      if (!ownerBootstrap) access.requireUnbanned(player);
      async function readInput(limit) {
        const result=await readBody(request,limit);
        if (!ownerBootstrap) access.requireUnbanned(player);
        return result;
      }
      async function readMovementInput(limit) {
        const input=await readInput(limit);
        const current=access.authenticate(readAccessCookie(request));
        if (current?.uid!==player || current?.deviceId!==credential.deviceId) throw new RequestError(401,'session_required');
        if (activeElsewhere(current)) throw new RequestError(409,'profile_active_elsewhere');
        return input;
      }
      if (path==='/api/access' && method==='GET') return json(response,200,accessView(credential,owner));
      if (path === '/api/session' && method === 'POST') {
        const input=await readInput();
        const {credential:joined,token}=access.signIn(input,{credential,ownerBootstrap:accessView(undefined,owner).ownerBootstrap,
          legacy:!inviteRequired?readAccessCookie(request,legacyCookieName):undefined,headers:request.headers});
        restoreSoloPosition(joined.uid);
        return json(response,200,session(joined,owner),token?{'Set-Cookie':accessCookie(token,requestSecure)}:{});
      }
      if ((path==='/api/access/owner' || path==='/api/npcs/admin') && method==='POST') {
        if (!owner) throw new RequestError(403,'owner_only');
        const legacyRoute=path==='/api/npcs/admin';
        const {credential:joined,token}=access.bootstrap(await readInput(),{credential,legacyRoute,
          legacy:readAccessCookie(request,legacyCookieName),source:request.socket.remoteAddress});
        if (survival.enabled) sendSocial('game-mode',playerMode(joined.uid),id=>id===joined.uid);
        const body=session(joined,owner);
        return json(response,200,legacyRoute?{...body,editor:true}:body,token?{'Set-Cookie':accessCookie(token,requestSecure)}:{});
      }
      if (!player) throw new RequestError(401, 'session_required');
      if (terrainPreload && path==='/api/terrain-preload' && method==='GET') {
        requireSameOrigin(request,requestSecure,requestOrigin);
        return terrainPreload(response,url.searchParams,player);
      }
      if (path==='/api/altitude-music' && (method==='GET' || method==='HEAD')) {
        requireSameOrigin(request,requestSecure,requestOrigin);
        const file=altitudeTrackFile();
        if (!file) throw new RequestError(404,'not_found');
        response.setHeader('Vary','Cookie');
        response.setHeader('Cross-Origin-Resource-Policy','same-origin');
        return serveAudioRecording(request,response,altitudeTrack,{file,type:MIME['.mp3'],cacheControl:'private, no-store'});
      }
      if (switchSoloWorld && method==='POST' && path==='/api/solo-world/switch') {
        await readInput();
        saveSoloPosition();
        const port=await switchSoloWorld();
        if (!Number.isInteger(port) || port<1 || port>65535) throw new Error('Invalid local destination port');
        if (!response.destroyed) return json(response,200,{url:`http://127.0.0.1:${port}/`});
        return;
      }
      if (path==='/api/player-diagnostics' && method==='POST') {
        if (!studying) throw new RequestError(403,'player_diagnostics_inactive');
        const samples=parsePlayerDiagnostics(await readInput(playerDiagnosticsBodyLimit));
        if (!playerDiagnostics.active(player)) throw new RequestError(403,'player_diagnostics_inactive');
        loadLog?.studyClientReport(credential.deviceId,samples,player);
        response.writeHead(204,{'Cache-Control':'no-store'});
        response.end();
        return;
      }
      if (path==='/api/connection-report' && method==='POST') {
        const events=connectionReport(await readInput());
        loadLog?.clientReport(credential.deviceId,events,Boolean(studying),player);
        response.writeHead(204,{'Cache-Control':'no-store'});
        response.end();
        return;
      }
      if (path==='/api/admin/network-diagnostics' && method==='GET') {
        if (!owner || !access.view(credential,owner).owner) throw new RequestError(403,'owner_required');
        requireSameOrigin(request,requestSecure,requestOrigin);
        if (!loadLog) throw new RequestError(404,'not_found');
        const rawHours=url.searchParams.get('hours')??'6';
        if (!/^(?:[1-9]|1\d|2[0-4])$/.test(rawHours)) throw new RequestError(400,'invalid_network_diagnostics_window');
        const report=await loadLog.networkDiagnostics(Number(rawHours));
        const nicknames=new Map(access.profiles().map(({uid,nickname,profileName})=>[networkPlayerTag(uid),nickname||profileName]));
        for (const player of report.players) {
          const nickname=nicknames.get(player.player);
          if (nickname) player.nickname=nickname;
        }
        return json(response,200,report);
      }
      if (path==='/api/access/logout' && method==='POST') {
        await readInput();
        const result=access.revokeDevice(credential);
        return json(response,200,result,{'Set-Cookie':[accessCookie('',requestSecure,0),legacyClearCookie(requestSecure)]});
      }
      if (path==='/api/night-vision' && method==='POST') {
        const {enabled,initialize}=await readInput();
        return json(response,200,setNightVision(player,enabled,initialize));
      }
      if (path==='/api/admin/access' && method==='GET') {
        const panel=access.listAdmin(credential,presence.onlineProfile);
        for (const row of panel.profiles) {
          const {ponyType,size,raceOverride,sizeOverride}=playerTraits(row.uid);
          Object.assign(row,{ponyType,size,raceOverride,sizeOverride,mode:survival.mode(row.uid),
            nightVision:store.getNightVision(row.uid)?.enabled??null});
        }
        return json(response,200,panel);
      }
      if (path==='/api/admin/uids' && method==='GET') return json(response,200,access.listUids(player));
      if (method==='POST' && (path==='/api/admin/profiles/race' || path==='/api/admin/profiles/size')) {
        if (!access.isAdmin(player)) throw new RequestError(403,'admin_required');
        const {uid,ponyType,size}=await readInput();
        if (!access.account(uid)) throw new RequestError(404,'player_missing');
        const changingSize=path.endsWith('/size');
        const value=changingSize?size:ponyType;
        if (value!==null && !(changingSize?ponySizes:ponyRaces).has(value)) {
          throw new RequestError(400,changingSize?'invalid_pony_size':'invalid_pony_type');
        }
        const field=changingSize?'sizeOverride':'raceOverride';
        const previous=playerTraits(uid);
        if (previous[field]===value) return json(response,200,raceSnapshot(uid));
        if (changingSize && previous.size!==(value??previous.skinSize)) game.initializePosition(uid);
        const drop=changingSize ? undefined : prepareRaceDrop(uid,previous.ponyType,value??previous.skinPonyType);
        store.setPonyTraits(uid,{[field]:value},drop?.writeInventory);
        const traits=rememberTraits(uid,{size:previous.skinSize,ponyType:previous.skinPonyType});
        const relocation=reconcilePonyTraits(uid,previous,traits,drop);
        const profile=profileFor(uid);
        const snapshot=raceSnapshot(uid,profile);
        presence.profile(uid,avatarProfile(profile));
        const position=presence.onlinePosition(uid);
        if (position) {
          if (relocation) presence.update(uid,relocation.position,game.poseFor(uid,{motion:'idle'}));
          else presence.update(uid,position,{offhand:game.offhandPose(uid)});
        }
        publishProfileSetting(uid,'profile-race',snapshot);
        return json(response,200,snapshot);
      }
      if (path==='/api/admin/profiles/night-vision' && method==='POST') {
        if (!access.isAdmin(player)) throw new RequestError(403,'admin_required');
        const {uid,enabled}=await readInput();
        if (!access.account(uid)) throw new RequestError(404,'player_missing');
        return json(response,200,setNightVision(uid,enabled));
      }
      if (path==='/api/admin/profiles/role' && method==='POST') {
        const {uid,role}=await readInput();
        const result=access.setRole(player,uid,role);
        if (result.changed) {
          if (role==='player' && game.isSpectator(uid)) setPlayerSpectator(uid,false);
          presence.refreshRoster();
          presence.flush();
          publishProfileSetting(uid,'profile-access',{uid,role});
          sendSocial('game-mode',playerMode(uid),candidate=>candidate===uid);
        }
        return json(response,200,result);
      }
      if (path==='/api/admin/invites' && method==='POST')
        return json(response,200,access.issue(player,await readInput()));
      if (path==='/api/admin/invites/revoke' && method==='POST') {
        const {id}=await readInput();
        return json(response,200,access.revokeInvite(player,id));
      }
      if (path==='/api/admin/devices/revoke' && method==='POST') {
        const {id}=await readInput();
        const result=access.revokeDevice(credential,id,false);
        return json(response,200,result,id===credential.deviceId?{'Set-Cookie':[accessCookie('',requestSecure,0),legacyClearCookie(requestSecure)]}:{});
      }
      if (method==='POST'&&(path==='/api/admin/profiles/ban'||path==='/api/admin/profiles/unban')) {
        const {uid,reason}=await readInput();
        return json(response,200,access.setBan(player,uid,reason,path.endsWith('/ban')));
      }
      if (path==='/api/admin/dropped-items/clear'&&method==='POST') {
        await readInput();
        if (!access.isAdmin(player)) throw new RequestError(403,'admin_required');
        const removed=game.clearDroppedItems();
        broadcastDroppedItems(true);
        return json(response,200,{removed});
      }
      const presenceStream=path==='/api/events' && url.searchParams.get('presence')==='1';
      if ((presenceStream || (method==='POST'||method==='DELETE')&&!parallelDeviceRoutes.has(path)) && activeElsewhere(credential)) {
        throw new RequestError(409,'profile_active_elsewhere');
      }
      if (path==='/api/admin/teleport'&&method==='POST') {
        if (!access.isAdmin(player)) throw new RequestError(403,'admin_required');
        const {target,direction}=await readInput();
        if (direction!=='to'&&direction!=='bring') throw new RequestError(400,'invalid_admin_teleport');
        const bring=direction==='bring';
        const member=access.adminTarget(player,target,bring);
        return json(response,200,adminTeleport(player,bring?member:player,bring?player:member));
      }
      if (path==='/api/admin/inventory/clear' && method==='POST') {
        await readInput();
        if (!access.isAdmin(player)) throw new RequestError(403,'admin_required');
        const inventory=game.clearInventory(player);
        const position=presence.onlinePosition(player);
        if (position) presence.update(player,position,{equipment:inventory.equipment,offhand:null});
        publishProfileSetting(player,'profile-inventory',inventory);
        return json(response,200,{inventory});
      }
      if (path==='/api/worldedit' && method==='GET') return json(response,200,worldEdit.read(player));
      if (path==='/api/worldedit' && method==='POST') {
        if (!presence.onlineProfile(player)) throw new RequestError(409,'not_online');
        const result=worldEdit.action(player,await readInput());
        if (result.changes?.length) {
          const {worldRevision,changes,effects,frames}=result;
          broadcast(player,{worldRevision,changes,effects,frames});
        }
        return json(response,200,result);
      }
      if (path==='/api/npcs' && method==='GET') return json(response,200,npcs.snapshot(player));
      if (path==='/api/npcs/editor' && method==='GET') return json(response,200,npcs.editor(player));
      if (path==='/api/npcs/editor' && method==='POST') {
        if (!npcs.isAdmin(player)) throw new RequestError(403,'npc_editor_required');
        const next=npcs.edit(player,await readInput(MAX_NPC_EDITOR_BODY));
        for (const stream of streams) sendNpcs(stream);
        return json(response,200,next);
      }
      if (path==='/api/npcs/action' && method==='POST') {
        if (!presence.onlineProfile(player)) throw new RequestError(409,'not_online');
        if (survival.dead(player)) throw new RequestError(409,'player_dead');
        const result=await npcs.action(player,await readInput(),()=>response.destroyed);
        if (!response.destroyed) return json(response,200,result);
        return;
      }
      if (path==='/api/modes' && survival.enabled) {
        if (!npcs.isAdmin(player)) throw new RequestError(403,'admin_required');
        let observing;
        if (method==='POST') {
          const {mode,target}=await readInput();
          if (!npcs.isAdmin(player)) throw new RequestError(403,'admin_required');
          const member=target===undefined ? undefined : access.account(target)?.uid??[...streams].map(stream=>stream.player)
            .find(id=>presence.onlineProfile(id)?.id===target);
          if (target!==undefined&&!member) throw new RequestError(404,'player_missing');
          if (member && member!==player) access.adminTarget(player,member,true);
          if (mode==='spectator') {
            if (!member || !presence.onlinePosition(member)) throw new RequestError(409,'not_online');
            observing=setPlayerSpectator(member,true);
          } else {
            ({observing}=changePlayerMode(member,mode));
          }
        }
        return json(response,200,{...modeAdministration(),selfMode:playerMode(player),...(observing&&{observing})});
      }
      if (path==='/api/combat' && method==='POST' && survival.enabled) {
        const {target}=await readInput();
        if (!presence.onlineProfile(player)) throw new RequestError(409,'not_online');
        const defender=[...streams].map(stream=>stream.player).find(id=>!game.isSpectator(id) && presence.onlineProfile(id)?.id===target);
        if (!defender) throw new RequestError(404,'player_missing');
        return json(response,200,{hit:Boolean(game.hitPlayer(player,defender))});
      }
      if (path==='/api/craft' && method==='POST' && survival.enabled) {
        const {recipe}=await readInput();
        if (!presence.onlineProfile(player)) throw new RequestError(409,'not_online');
        return json(response,200,{inventory:game.craft(player,recipe)});
      }
      if (path === '/api/chat' && method === 'POST') {
        const body = await readInput(MAX_CHAT_BODY);
        const command=await adminCommands.execute(player,body?.text);
        if (command) return json(response,200,command);
        if (game.isSpectator(player)) throw new RequestError(403,'spectator_action');
        return json(response, 200, chat.message(presence.onlineProfile(player), body, player, presence.onlinePosition(player)));
      }
      if (path === '/api/time' && method === 'POST') {
        const body = await readInput();
        if (!access.isAdmin(player)) throw new RequestError(403,'admin_required');
        return json(response,200,updateWorldTime(body));
      }
      if (path === '/api/weather' && method === 'GET') return json(response,200,worldTime.weatherSettings());
      if (path === '/api/weather' && method === 'POST') {
        const body=await readInput();
        if (!access.isAdmin(player)) throw new RequestError(403,'admin_required');
        return json(response,200,updateWorldWeather(body));
      }
      if (path === '/api/profile' && method === 'POST') {
        const updates = await profileChanges(await readInput(MAX_PROFILE_BODY));
        access.requireUnbanned(player);
        const saved = store.getProfile(player);
        const submittedSkin = updates.skin;
        const previousTraits = submittedSkin === undefined ? undefined : playerTraits(player,saved);
        const nextSkinTraits=submittedSkin ?? {size:'normal',ponyType:'earth'};
        if (previousTraits && previousTraits.size!==nextSkinTraits.size) game.initializePosition(player);
        if (updates.nickname === saved?.nickname) delete updates.nickname;
        if (updates.skin !== undefined && (updates.skin?.hash ?? null) === (saved?.skinHash ?? null)) delete updates.skin;
        if (submittedSkin !== undefined) updates.ponyTraits={raceOverride:null,sizeOverride:null};
        const different = updates.nickname !== undefined || submittedSkin !== undefined;
        const drop=previousTraits && prepareRaceDrop(player,previousTraits.ponyType,nextSkinTraits.ponyType);
        const silentRename=game.isSpectator(player);
        const renameDate=updates.nickname!==undefined && !silentRename ? chat.stamp() : undefined;
        const renameChat=silentRename ? {announce:false} : renameDate && {at:renameDate.at,admin:access.isAdmin(player)};
        const renamed = different && store.updateProfile(player, updates,
          saved?.nickname ?? presence.onlineProfile(player)?.nickname,drop?.writeInventory,renameChat);
        let relocation, movementState;
        if (submittedSkin !== undefined) {
          const traits=rememberTraits(player,nextSkinTraits);
          const {size,ponyType}=traits;
          relocation=reconcilePonyTraits(player,previousTraits,traits,drop);
          if (!relocation && (size!==previousTraits.size || ponyType!==previousTraits.ponyType)) {
            const {position,seat,stance}=game.session(player);
            movementState={position,seat,stance};
          }
        }
        const profile = profileFor(player, different ? store.getProfile(player) : saved);
        if (different) presence.profile(player, avatarProfile(profile));
        if (relocation) presence.update(player,relocation.position,game.poseFor(player,{motion:'idle'}));
        if (submittedSkin!==undefined) {
          const position=presence.onlinePosition(player);
          if (position) presence.update(player,position,{offhand:game.offhandPose(player)});
          publishProfileSetting(player,'profile-race',raceSnapshot(player,profile));
        }
        if (renamed) chat.publishRecorded(renamed,null,renameDate,presence.onlinePosition(player));
        return json(response, 200, {...profile,...relocation,...movementState,...game.abilityState(player),
          ...(survival.enabled && {gameMode:playerMode(player)})});
      }
      if (path === '/api/presence') {
        if (method === 'POST') {
          const body = await readInput();
          const pose = readPose(body);
          const fallback=body.fallbackPage!==undefined;
          const {afk,page}=body;
          if (afk!==undefined && (typeof afk!=='boolean' || !isMovementPage(page) || pose.seq===undefined)) {
            throw new RequestError(400,'invalid_pose');
          }
          const ownsPage=value=>game.movementChannel.owns(player,credential.deviceId,value);
          if (fallback && (!isMovementPage(body.fallbackPage) || !ownsPage(body.fallbackPage))) {
            throw new RequestError(409,'movement_page_replaced');
          }
          const activity=afk!==undefined && ownsPage(page) ? {afk,page,seq:pose.seq,deviceId:credential.deviceId} : undefined;
          if (body.cartDrive !== undefined && ![-1,0,1].includes(body.cartDrive)) throw new RequestError(400,'invalid_pose');
          if (body.boatDrive !== undefined && (!Array.isArray(body.boatDrive) || body.boatDrive.length !== 2 ||
              body.boatDrive.some(value => ![-1,0,1].includes(value)))) throw new RequestError(400,'invalid_pose');
          game.driveMinecart(player,pose,body.cartDrive,body.boatDrive);
          const {position, seat, stance} = game.session(player);
          presence.join(player, position, {...game.poseFor(player,pose),
            ...(survival.enabled&&{death:survival.avatarDeath(player)})},{fallback,activity});
          return json(response, 200, {ok:true, position, seat, stance});
        }
        if (method === 'DELETE') {
          presence.leave(player);
          return json(response, 200, {ok: true});
        }
      }
      if (path === '/api/seat' && method === 'POST') {
        if (survival.dead(player)) throw new RequestError(409,'player_dead');
        const body = await readInput();
        if (!presence.onlineProfile(player)) throw new RequestError(409, 'not_online');
        if (body.ground !== undefined && (typeof body.ground !== 'boolean' || body.target !== undefined)) {
          throw new RequestError(400,'invalid_coordinates');
        }
        const pose = readPose(body);
        const result = game.sit(player, body.target, pose,body.ground);
        presence.update(player, result.position, game.poseFor(player, {
          ...pose, yaw:result.seat?.yaw ?? pose.yaw, pitch:result.seat ? 0 : pose.pitch, motion:'idle',
        }));
        return json(response, 200, result);
      }
      if (path === '/api/world' && method === 'GET') {
        const cursor = url.searchParams.get('since');
        const delta = url.searchParams.get('delta') === '1' ? {
          epoch:url.searchParams.get('epoch'), since:/^\d+$/.test(cursor ?? '') ? Number(cursor) : undefined,
        } : undefined;
        return json(response, 200, game.snapshot(player, delta));
      }
      if (path === '/api/flight' && method === 'POST') {
        const flight=game.setFlight(player,credential.deviceId,await readMovementInput());
        return json(response,200,{flight});
      }
      if (path==='/api/magic-teleport' && method==='POST') {
        const body=await readMovementInput();
        if (!presence.onlineProfile(player)) throw new RequestError(409,'not_online');
        const result=game.magicTeleport(player,body);
        return json(response,200,publishTeleport(player,result,body.yaw%(2*Math.PI),body.pitch));
      }
      if (path === '/api/position-state' && method === 'POST') {
        const {page,start,restart}=await readMovementInput();
        const state=typeof restart==='string'
          ? game.movementChannel.restart(player,credential.deviceId,page,restart)
          : {movement:game.movementChannel.open(player,credential.deviceId,page,start===true)};
        return json(response,200,state);
      }
      if (path === '/api/position' && method === 'POST') {
        const body = await readMovementInput(MAX_MOVEMENT_BODY);
        if (body.page !== undefined) {
          // Parse the pose before storing a packet that arrived out of order.
          if (body.pose !== undefined) body.pose=readPose(body.pose);
          const movement = game.movementChannel.receive(player,credential.deviceId,body,packet=>{
            const {effects,changes,...result} = game.position(player,packet);
            presence.update(player,result.position,game.poseFor(player,packet.pose));
            if (changes.length || effects.length) broadcast(player,{...result,changes,effects});
            return {...((effects.length || changes.length) && {commit:{effects,changes,worldRevision:result.worldRevision}}),deliver(state) {
              for (const stream of streams) {
                if (stream.player===player && stream.deviceId===credential.deviceId && stream.movementPage===packet.page) {
                  writeEvent(stream.response,'movement-ack',{movement:state});
                }
              }
            }};
          });
          return json(response,200,{movement});
        }
        for (const stream of streams) {
          if (stream.player!==player || !stream.movementPage || stream.response.destroyed || stream.response.writableEnded) continue;
          const current=game.movementChannel.state(player,stream.deviceId,stream.movementPage);
          if (current) throw new RequestError(409,'movement_page_replaced',{
            position:current.position, stance:current.stance, ...(current.seat && {seat:current.seat}),
          });
        }
        const pose = body.pose === undefined ? undefined : readPose(body.pose);
        const result = game.position(player, body);
        presence.update(player, result.position, game.poseFor(player, pose));
        if (result.changes.length || result.effects.length) broadcast(player, result);
        return json(response, 200, result);
      }
      if (path === '/api/respawn' && method === 'POST') {
        await readInput();
        const death=survival.avatarDeath(player);
        const result=death?game.revive(player,death):game.respawn(player);
        if (death) survival.reset(player);
        presence.update(player, result.position, game.poseFor(player, {yaw:0, pitch:0, motion:'idle'}));
        if (death) survivalChanged(player,survival.status(player));
        return json(response, 200, {...result,...(survival.enabled&&{gameMode:playerMode(player)})});
      }
      if (path === '/api/spectator' && method === 'POST') {
        const body = await readInput();
        if (!access.isAdmin(player)) throw new RequestError(403,'admin_required');
        if (!presence.onlineProfile(player)) throw new RequestError(409, 'not_online');
        const pose = readPose(body.pose);
        return json(response,200,setPlayerSpectator(player,body.enabled,pose));
      }
      if (path === '/api/warps' && method === 'GET') {
        if (!access.isAdmin(player)) throw new RequestError(403,'admin_required');
        return json(response,200,warps.list());
      }
      if ((path === '/api/warps' || path === '/api/warps/remove') && method === 'POST') {
        if (!access.isAdmin(player)) throw new RequestError(403,'admin_required');
        const body = await readInput();
        if (!presence.onlineProfile(player)) throw new RequestError(409,'not_online');
        const next = path === '/api/warps' ? warps.add(body.title,game.session(player).position) : warps.remove(body.id);
        sendSocial('warps',next,access.isAdmin);
        return json(response,200,next);
      }
      if (path === '/api/teleport' && method === 'POST') {
        if (!access.isAdmin(player)) throw new RequestError(403,'admin_required');
        const body = await readInput();
        if (!presence.onlineProfile(player)) throw new RequestError(409, 'not_online');
        const target = body.warpId === undefined ? body : warps.get(body.warpId).position;
        await ensureSoloArea(target);
        if (response.destroyed) return;
        return json(response,200,teleportPlayer(player,target));
      }
      if (path === '/api/action' && method === 'POST') {
        const result = game.action(player, await readInput(MAX_ACTION_BODY));
        if (!result.replay && result.status === 200) {
          afterCommit?.(request, response, result.output);
          broadcast(player, result.output);
          if (result.output.inventory) {
            const online=presence.onlinePosition(player);
            if (online) presence.update(player,online,{equipment:result.output.inventory.equipment,
              offhand:game.offhandPose(player,result.output.inventory)});
          }
          if (result.output.minecart || result.output.removedMinecart || result.output.boat || result.output.removedBoat) broadcastMinecarts();
          if (result.output.droppedItem || result.output.pickedItem) broadcastDroppedItems(true);
        }
        if (!response.destroyed) json(response, result.status, result.output);
        return;
      }
      if (path === '/api/events' && method === 'GET') {
        if ([...streams].filter(stream=>stream.player===player).length>=MAX_PROFILE_STREAMS) {
          throw new RequestError(429,'profile_stream_limit');
        }
        if (streams.size >= MAX_STREAMS) throw new RequestError(503, 'stream_limit');
        const presenceEntry = presenceStream && presence.prepare(player);
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
        });
        const stream = { player, response, deviceId:credential.deviceId,presence:Boolean(presenceEntry),social: url.searchParams.get('social') === '1',
          minecarts: url.searchParams.get('minecarts') === '1',
          droppedItems: url.searchParams.get('droppedItems') === '1',
          npcs: url.searchParams.get('npcs') === '1' };
        const movementPage=url.searchParams.get('movement');
        if (isMovementPage(movementPage)) stream.movementPage=movementPage;
        streams.add(stream);
        game.touch(player);
        response.on('close', () => {
          streams.delete(stream);
          presence.disconnect(stream);
        });
        const page=url.searchParams.get('diag');
        const study=studying && page && diagnosticPagePattern.test(page) && {...playerDiagnostics.session(player),page};
        const streamId=loadLog?.openStream(response,credential.deviceId,stream.presence,study,player);
        if (study) {
          stream.studyId=streamId;
          stream.studyPage=study.page;
          sendStudyHeartbeat(stream);
        }
        const cursor = request.headers['last-event-id'] ?? url.searchParams.get('since');
        const epoch = url.searchParams.get('epoch');
        const revision = game.worldRevision();
        const stale = (cursor !== null && Number(cursor) !== revision) || (epoch !== null && epoch !== game.worldEpoch);
        const kind = stale ? 'reset' : 'ready';
        writeEvent(response, kind, { worldRevision: revision, contentHash: game.contentHash }, revision);
        if (stream.movementPage) {
          const movement=game.movementChannel.state(player,credential.deviceId,stream.movementPage);
          if (movement) writeEvent(response,'movement-ack',{movement});
        }
        if (presenceEntry) {
          presence.connect(stream, presenceEntry);
          const role=access.account(player)?.role;
          if (role) writeEvent(response,'profile-access',{uid:player,role});
          if (spectatorRevisions.has(player)) writeEvent(response,'profile-spectator',spectatorSnapshot(player));
          writeEvent(response,'profile-race',raceSnapshot(player));
          const nightVision=store.getNightVision(player);
          if (nightVision) writeEvent(response,'profile-night-vision',{uid:player,...nightVision});
        }
        if (stream.social) {
          writeEvent(response, 'world-time', worldTime.snapshot());
          writeEvent(response, 'weather', worldTime.weatherSettings());
          if (survival.enabled) writeEvent(response,'game-mode',playerMode(player));
        }
        if (stream.minecarts) writeEvent(response,'minecarts',game.minecartSnapshot(player));
        sendDroppedItems(stream,true);
        sendNpcs(stream);
        if (stream.social) sendChatHistory(stream);
        return;
      }
      throw new RequestError(404, 'not_found');
    }

    if (method !== 'GET' && method !== 'HEAD') throw new RequestError(405, 'method_not_allowed');
    if (inviteRequired&&gameAsset) {
      response.setHeader('Vary','Cookie');
      if (!credential) throw new RequestError(401,'session_required');
      access.requireUnbanned(credential.uid);
    }
    if (soloCache && path.startsWith('/generated/') && !(testRange && path.startsWith('/generated/world/'))) {
      if (path.startsWith('/generated/lod/') || path.startsWith('/generated/vista/')) {
        const tile=/^\/generated\/(lod|vista)\/([a-f0-9]{64})\/(-?\d+\.-?\d+(?:\.outer)?\.bin)$/.exec(path);
        if (tile && tile[2]===(tile[1]==='lod'?lod?.descriptor.contentHash:vista?.descriptor.hash)) {
          await ensureSoloFile(`${tile[1]}/${tile[3]}`,1);
        }
      } else {
        let relative;
        try { relative=path.slice('/generated/'.length).split('/').map(decodeURIComponent).join('/'); } catch {}
        if (relative && !relative.startsWith('world/chunks/')) await ensureSoloFile(relative);
      }
    }
    if (path.startsWith('/generated/npcs/sound/')) {
      let name;
      try { name=decodeURIComponent(path.slice('/generated/npcs/sound/'.length)); }
      catch { throw new RequestError(404,'not_found'); }
      if (!npcs.sounds.has(name)) throw new RequestError(404,'not_found');
      return serveAudioRecording(request,response,join(generated,'npcs','sound',name));
    }
    const npcModel=path.match(/^\/generated\/npcs\/([a-zA-Z0-9]+\.json)$/)?.[1];
    if (npcModel && !privateNpcFiles.has(npcModel.toLowerCase()) &&
        await serveFile(request,response,join(generated,'npcs',npcModel))) return;
    if (path.startsWith('/generated/npcs/skins/')) {
      let segments;
      try { segments=path.slice('/generated/npcs/skins/'.length).split('/').map(decodeURIComponent); }
      catch { throw new RequestError(404,'not_found'); }
      if (segments.length<=8 && segments.every(segment=>segment.length<=150 &&
          /^(?!\.{1,2}$)[\p{L}\p{N} ._()-]+$/u.test(segment) && !segment.endsWith('.') && !segment.endsWith(' ')) &&
          /\.png$/i.test(segments.at(-1)) && await serveFile(request,response,join(generated,'npcs','skins',...segments))) return;
      throw new RequestError(404,'not_found');
    }
    if (creative && path === '/generated/creative/catalog.json') {
      return serveWorld(request, response, path, () => creative.catalog);
    }
    const skin = path.match(/^\/skins\/([a-f0-9]{64})\.png$/);
    if (skin) {
      const png = store.getSkin(skin[1]);
      if (!png) throw new RequestError(404, 'not_found');
      response.writeHead(200, { 'Content-Type': MIME['.png'], 'Content-Length': png.length,
        'Cache-Control':`${inviteRequired?'private':'public'}, max-age=31536000, immutable` });
      response.end(method === 'HEAD' ? undefined : png);
      return;
    }
    if (path === '/generated/world/world.json') {
      return serveWorld(request, response, path, () => manifest);
    }
    if (path === '/generated/weather/biomes.bin') {
      if (await serveClimateMap(generated,request,response,acceptsGzip(request.headers['accept-encoding']))) return;
    }
    if (path.startsWith('/generated/lod/')) {
      if (await serveLodTile(lod, request, response, path, acceptsGzip(request.headers['accept-encoding']))) return;
      throw new RequestError(404, 'not_found');
    }
    if (path.startsWith('/generated/vista/')) {
      if (await serveVistaTile(vista, request, response, path, acceptsGzip(request.headers['accept-encoding']))) return;
      throw new RequestError(404, 'not_found');
    }
    const chunk = path.match(/^\/generated\/world\/chunks\/(?:(?<version>[0-9a-f]{64})\/)?(?<x>-?\d+)\.(?<z>-?\d+)\.json$/);
    if (chunk) {
      const {version} = chunk.groups;
      if (version && version !== chunkCacheVersion) throw new RequestError(404, 'chunk_version_changed');
      const x = Number(chunk.groups.x);
      const z = Number(chunk.groups.z);
      if (streamedWorld && base.worldCoverage?.(x,z)) {
        await ensureSoloFile(soloRegionFile(x,z),15);
        const ground = game.resolveLogGround(x,z);
        if (ground) broadcast(null,ground);
      }
      const highOnly=url.searchParams.get('height')==='upper';
      return serveWorld(request, response, `chunk:${x}.${z}${highOnly?':upper':''}`, () => base.publicChunk(x, z, highOnly),
        version ? 'private, max-age=2592000, immutable' : undefined);
    }
    const terrain = path.match(/^\/generated\/world\/(terrain-(?:8|16|32)\.json)$/);
    if (terrain) {
      if (!base.manifest.terrain?.some(ring => ring.file === terrain[1])) throw new RequestError(404, 'not_found');
      return serveWorld(request, response, path, () => readFileSync(join(generated, 'world', terrain[1])));
    }
    const filename = staticPath(path, project, generated);
    if (!filename || !await serveFile(request, response, filename)) throw new RequestError(404, 'not_found');
  }

  const comparisonHost = secure && comparisonOrigin ? new URL(comparisonOrigin).host : undefined;
  function listener(privatePort) {
    const http=createServer({requestTimeout:15000},(request,response)=>{
      const owner=(privatePort || ownerOnPrimary&&!secure) && ownerRequest(request,http.address());
      if (singlePlayer&&!owner) return json(response,403,{error:'local_only'});
      if (privatePort&&!owner) return json(response,403,{error:'owner_only'});
      const requestOrigin=privatePort ? undefined :
        comparisonHost && request.headers.host===comparisonHost ? comparisonOrigin : allowedOrigin;
      dispatch(request,response,owner,!privatePort&&secure,requestOrigin).catch(error=>{
        if (response.destroyed) return;
        if (response.headersSent) return destroyStream(response,'handler_error');
        if (error instanceof RequestError) return json(response,error.status,{error:error.code,...error.details});
        console.error(error);
        return json(response,500,{error:'internal_error'});
      });
    });
    if (loadLog) http.on('connection',socket=>socket.on(errorMonitor,error=>loadLog.socketError(error.code)));
    return http;
  }
  const server=listener(false);
  const soloPositionTimer=persistSoloPosition ? setInterval(saveSoloPosition,5000) : undefined;
  soloPositionTimer?.unref();
  if (localJournal) server.once('listening',()=>localJournal.record({kind:'server-start',build}));
  let networkProbe;
  server.once('listening',()=>{
    loadLog?.start();
    if (monitorNetwork && loadLog) {
      networkProbe=startNetworkProbe({port:server.address().port,publicOrigin,record:sample=>loadLog.networkSample(sample)});
    }
  });
  const ownerServer=listener(true);
  const heartbeat = setInterval(() => {
    for (const stream of streams) {
      const {player,response}=stream;
      game.touch(player);
      writeEvent(response,'stream-heartbeat',{});
      loadLog?.heartbeat(response);
      sendStudyHeartbeat(stream);
    }
  }, 15000);
  heartbeat.unref();
  const presenceTicks = setInterval(() => presence.flush(), 100);
  presenceTicks.unref();
  const weatherTicks=setInterval(()=>{
    try {
      const changed=worldTime.advanceWeather();
      if (changed) sendSocial('weather',changed);
    } catch (error) { console.error(error); }
  },1000);
  weatherTicks.unref();
  const npcTicks=setInterval(()=>{
    try {
      const online=new Map();
      for (const {player} of streams) {
        const position=presence.onlinePosition(player);
        if (position && !online.has(player)) online.set(player,{id:player,position,spectator:game.npcPlayerView(player).spectator});
      }
      if (survival.enabled) {
        game.advanceLava(online.keys());
        survival.tick(online.keys(),survivalChanged);
      }
      npcs.tick([...online.values()]);
      for (const stream of streams) sendNpcs(stream);
    } catch(error) { console.error(error); }
  },200);
  npcTicks.unref();
  let itemRefresh = 0;
  const blockTicks = setInterval(() => {
    try {
      const result = game.advance();
      if (result?.changes.length || result?.effects.length) broadcast(null, result);
      const riders = game.advanceMinecarts();
      if (riders) {
        for (const {player,position,pose} of riders) presence.update(player,position,pose);
        broadcastMinecarts();
      }
      if (game.advanceDroppedItems()) broadcastDroppedItems(true);
      else if (++itemRefresh % 10 === 0) broadcastDroppedItems(false);
    } catch (error) {
      console.error(error);
    }
  }, 50);
  blockTicks.unref();

  return {
    server,
    ownerServer,
    game,
    npcs,
    async close() {
      networkProbe?.close();
      if (soloPositionTimer) {
        clearInterval(soloPositionTimer);
        saveSoloPosition();
      }
      clearInterval(heartbeat);
      clearInterval(presenceTicks);
      clearInterval(weatherTicks);
      clearInterval(npcTicks);
      clearInterval(blockTicks);
      for (const { response } of streams) {
        loadLog?.endStream(response,'server_shutdown');
        response.end();
      }
      await Promise.all([server,ownerServer].map(listener=>new Promise((success,fail)=>{
        listener.close(error=>{
          if (error&&error.code!=='ERR_SERVER_NOT_RUNNING') fail(error);
          else success();
        });
        listener.closeAllConnections();
      })));
      game.flushMinecarts();
      game.checkpointPositions();
      game.clearDroppedItems();
      await Promise.all([chat.close(),loadLog?.close()]);
      localJournal?.record({kind:'server-stop',build});
      store.close();
    },
  };
}

async function main() {
  const geometry = await import('../world/geometry.mjs');
  const host = process.env.HOST ?? '127.0.0.1';
  const secure=process.env.HONEYMOON_SECURE_COOKIE==='1';
  const remote=secure||!isLoopback(host);
  const app = createHoneymoonServer({
    geometry,
    generated: process.env.HONEYMOON_GENERATED && resolve(process.env.HONEYMOON_GENERATED),
    state: process.env.HONEYMOON_STATE && resolve(process.env.HONEYMOON_STATE),
    secure,
    allowedOrigin: process.env.HONEYMOON_ORIGIN,
    publicOrigin:process.env.HONEYMOON_ORIGIN,
    npcAdminKey:process.env.HONEYMOON_NPC_ADMIN_KEY,
    inviteRequired:remote||process.env.HONEYMOON_INVITE_REQUIRED==='1',
    ownerOnPrimary:!remote,
    initialMode:'game',
  });
  if (app.game.conflicts.length) console.log(JSON.stringify({ rebaseConflicts: app.game.conflicts }, null, 2));
  const port = Number(process.env.PORT ?? 4173);
  app.server.listen(port, host, () => console.log(`Lilium Moonlight http://${host}:${app.server.address().port}`));
  if (remote) app.ownerServer.listen(0,'127.0.0.1',()=>console.log(`Owner http://127.0.0.1:${app.ownerServer.address().port}/`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
