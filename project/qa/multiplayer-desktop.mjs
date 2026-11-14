import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {crc32, deflateSync} from 'node:zlib';
import {chromium} from 'playwright-core';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';
import {defaultPonyPixels} from '../world/pony-skins.mjs';

const output = process.argv[2] ?? 'work/multiplayer-desktop';
const viewport = {width:1280, height:720};
const dawn = {nickname:'Искра', marker:[249,177,49], type:'earth',
  colors:[[226,106,174], [114,45,99], [162,62,131], [130,57,97], [249,173,196]], accent:[245,215,132]};
const dusk = {nickname:'ЛунныйВетер', marker:[136,202,240], type:'pegasus',
  colors:[[64,205,148], [33,80,118], [63,144,187], [44,124,93], [137,227,178]], accent:[186,233,253]};
// A supplied URL should point to a disposable world, since the scenario places a block.
const externalUrl = process.env.HONEYMOON_TEST_URL;
const app = externalUrl ? null : createHoneymoonServer({state:':memory:', geometry});
const report = {viewport, players:[], cameras:[], walk:{}, turn:{}, flight:{}, effects:{}, reconnect:{}, errors:[]};
let browser;
let origin;
let stage = 'startup';

function skinPng({colors, marker, type, accent}) {
  const chunk = (type, data) => {
    const bytes = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4);
    const crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(bytes));
    return Buffer.concat([size, bytes, crc]);
  };
  const width = 64;
  const height = 32;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = width * 4 + 1;
  const rows = Buffer.alloc(stride * height);
  const pixels = defaultPonyPixels();
  const defaultColors = ['201,153,119', '86,60,105', '113,77,135', '139,99,105', '227,178,142'];
  const palette = new Map(defaultColors.map((color, i) => [color, colors[i]]));
  for (let i = 0; i < pixels.length; i += 4) {
    const replacement = palette.get(pixels.subarray(i, i + 3).join(','));
    if (pixels[i + 3] && replacement) pixels.set(replacement, i);
  }
  const tint = (x, y, color) => pixels.set([...color, 255], (y * width + x) * 4);
  tint(0, 0, marker);
  // Give each flank a visible emblem and the pegasus contrasting wings.
  for (const x of [26,34]) {
    for (const [dx, dy] of [[0,1],[1,0],[1,1],[1,2],[2,1]]) tint(x + dx, 3 + dy, accent);
  }
  if (type === 'pegasus') {
    for (let y = 16; y < 32; y++) {
      for (let x = 56; x < 64; x++) tint(x,y,(x + y) % 4 === 0 ? accent : colors[2]);
    }
  }
  for (let y = 0; y < height; y++) rows.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function watchPage(page) {
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400 && new URL(response.url()).pathname.startsWith('/api/')) {
      report.errors.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
    }
  });
}

async function newPage(context) {
  const page = await context.newPage();
  watchPage(page);
  await page.goto(origin, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => globalThis.honeymoon && !document.querySelector('#play').disabled, null, {timeout:90_000});
  return page;
}

async function enter(page) {
  await page.bringToFront();
  if (await page.locator('#play').isVisible()) {
    await page.locator('#play').click();
    await page.waitForFunction(() => document.querySelector('#entry').hidden, null, {timeout:15_000});
  }
}

async function joinPlayer(page, specification) {
  const png = skinPng(specification);
  await page.locator('#nickname').fill(specification.nickname);
  await page.locator('#pony-skin').setInputFiles({name:'pony.png', mimeType:'image/png', buffer:png});
  await page.waitForFunction(() => document.querySelector('#skin-status').textContent === 'pony.png');
  await enter(page);
  await page.waitForFunction(nickname => document.querySelector('#player-name').textContent.includes(nickname),
    specification.nickname);
  const response = await page.request.post(origin + '/api/session', {data:{}});
  assert.equal(response.status(), 200);
  const {profile} = await response.json();
  assert.equal(profile.nickname, specification.nickname);
  assert.ok(profile.id && profile.skin, 'Expected a persistent profile and an uploaded skin URL');
  const skin = await page.request.get(new URL(profile.skin, origin).href);
  assert.equal(skin.status(), 200);
  assert.match(skin.headers()['content-type'], /^image\/png(?:;|$)/);
  const uploaded = await skin.body();
  assert.ok(uploaded.subarray(0, 8).equals(png.subarray(0, 8)));
  const imageHash = createHash('sha256').update(uploaded).digest('hex');
  report.players.push({nickname:profile.nickname, skinHash:imageHash, ponyType:specification.type});
  return profile;
}

async function avatar(page, profile, requirements = {}) {
  await page.waitForFunction(({profile, requirements}) => {
    const player = honeymoon.players().find(candidate => candidate.id === profile.id);
    return player?.nickname === profile.nickname && player.skin === profile.skin && player.skinReady &&
      player.meshCount > 4 && Object.entries(requirements).every(([key, value]) => player[key] === value);
  }, {profile, requirements}, {timeout:20_000});
  return page.evaluate(id => honeymoon.players().find(player => player.id === id), profile.id);
}

async function aimAt(page, position, targetHeight = .85) {
  await page.evaluate(({position, targetHeight}) => {
    const eye = honeymoon.stats().position;
    const x = position.x - eye.x, y = position.y + targetHeight - eye.y - 1.62, z = position.z - eye.z;
    honeymoon.look(Math.atan2(-x,-z), Math.atan2(y,Math.hypot(x,z)));
  }, {position, targetHeight});
}

async function keyFor(page, code, duration) {
  await page.keyboard.down(code);
  try { await page.waitForTimeout(duration); }
  finally { await page.keyboard.up(code); }
}

async function aimBlock(page, destination) {
  await aimAt(page, {x:destination.x + .53,y:destination.y,z:destination.z + .53}, 1);
  await page.waitForFunction(({x,y,z}) => {
    const target = honeymoon.target();
    return target?.x === x && target.y === y && target.z === z && target.offset[1] === 1;
  }, destination, {timeout:8_000});
}

async function action(page, type, send) {
  const response = page.waitForResponse(result => result.url().endsWith('/api/action') &&
    result.request().postDataJSON()?.type === type);
  await send();
  const pending = await response;
  const body = await pending.json();
  assert.equal(pending.status(), 200, JSON.stringify(body));
  return body;
}

const stats = page => page.evaluate(() => honeymoon.stats());
const scene = page => page.locator('#scene');

async function captureAvatar(page, path, type) {
  const png = await scene(page).screenshot({path});
  const count = await page.evaluate(async ({body, type}) => {
    const screenshot = new Image();
    screenshot.src = 'data:image/png;base64,' + body;
    await screenshot.decode();
    const width = Math.round(screenshot.width * .18);
    const height = Math.round(screenshot.height * .45);
    const x = Math.round((screenshot.width - width) / 2);
    const y = Math.round((screenshot.height - height) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(screenshot, x, y, width, height, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      const [r, g, b] = pixels.subarray(i, i + 3);
      if (type === 'earth' ? r > 120 && b > 90 && r > g * 1.7 && b > g * 1.4 :
        g > 100 && b > 75 && g > r * 1.75 && g > b * 1.27) count++;
    }
    return count;
  }, {body:png.toString('base64'), type});
  assert.ok(count > 120, `Expected the uploaded ${type} skin to be visible, found ${count} matching pixels`);
  return count;
}

try {
  await mkdir(output, {recursive:true});
  if (app) {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    origin = `http://127.0.0.1:${app.server.address().port}`;
  } else {
    origin = new URL(externalUrl).origin;
  }
  browser = await chromium.launch({
    channel:'msedge', headless:process.env.HONEYMOON_HEADED !== '1',
    args:['--disable-renderer-backgrounding','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows'],
  });
  report.browser = browser.version();
  const dawnContext = await browser.newContext({viewport});
  const duskContext = await browser.newContext({viewport});
  stage = 'first player and skin upload';
  const dawnPage = await newPage(dawnContext);
  const dawnProfile = await joinPlayer(dawnPage, dawn);
  const initial = (await stats(dawnPage)).position;
  await dawnPage.evaluate(() => honeymoon.look(0, 0));
  await keyFor(dawnPage, 'KeyW', 900);
  await dawnPage.waitForFunction(z => honeymoon.stats().movementSync.confirmed[2] < z - 2, initial.z);
  await dawnPage.evaluate(() => honeymoon.look(2.22, 0));
  stage = 'second player and reciprocal views';
  const duskPage = await newPage(duskContext);
  assert.deepEqual(await dawnPage.evaluate(() => honeymoon.players()), [], 'Loading an entry screen should not spawn a pony');
  const duskProfile = await joinPlayer(duskPage, dusk);
  assert.notEqual(dawnProfile.id, duskProfile.id);
  assert.notEqual(dawnProfile.skin, duskProfile.skin);
  const seenDawn = await avatar(duskPage, dawnProfile);
  const seenDusk = await avatar(dawnPage, duskProfile);
  await duskPage.waitForFunction(id => honeymoon.players().some(player => player.id === id && Math.abs(player.yaw - 2.22) < .04), dawnProfile.id);
  await aimAt(duskPage, seenDawn.position, 1.1);
  const duskView = await avatar(duskPage, dawnProfile, {visible:true,onScreen:true});
  const pinkPixels = await captureAvatar(duskPage, join(output,'lunny-sees-iskra.png'), dawn.type);
  await duskPage.evaluate(() => honeymoon.look(.85, 0));
  await enter(dawnPage);
  await dawnPage.waitForFunction(id => honeymoon.players().some(player => player.id === id && Math.abs(player.yaw - .85) < .04), duskProfile.id);
  await aimAt(dawnPage, seenDusk.position, 1.1);
  const dawnView = await avatar(dawnPage, duskProfile, {visible:true,onScreen:true});
  const greenPixels = await captureAvatar(dawnPage, join(output,'iskra-sees-lunny.png'), dusk.type);
  report.cameras = [
    {viewer:dusk.nickname, model:dawn.nickname, meshes:duskView.meshCount, skinReady:duskView.skinReady, skinPixels:pinkPixels},
    {viewer:dawn.nickname, model:dusk.nickname, meshes:dawnView.meshCount, skinReady:dawnView.skinReady, skinPixels:greenPixels},
  ];
  assert.equal(duskView.ponyType, dawn.type);
  assert.equal(dawnView.ponyType, dusk.type);
  stage = 'remote walking animation';
  const beforeWalk = (await stats(dawnPage)).position;
  await dawnPage.evaluate(() => honeymoon.look(0, 0));
  await dawnPage.keyboard.down('KeyW');
  try {
    const walk = await avatar(duskPage, dawnProfile, {motion:'walk'});
    assert.ok(Number.isFinite(walk.phase), 'Other player walk animation must be active');
    await duskPage.waitForFunction(({id, angles, z}) => {
      const player = honeymoon.players().find(item => item.id === id);
      return player?.motion === 'walk' && player.position.z < z - .5 &&
        player.legAngles.some((angle, index) => Math.abs(angle - angles[index]) > .12);
    }, {id:dawnProfile.id, angles:walk.legAngles, z:beforeWalk.z}, {timeout:15_000});
    const next = await avatar(duskPage, dawnProfile, {motion:'walk'});
    assert.ok(Math.abs(next.yaw) < .12, `Expected north-facing avatar, got yaw ${next.yaw}`);
    report.walk = {phase:[walk.phase,next.phase], legAngles:[walk.legAngles,next.legAngles],
      before:beforeWalk, remote:next.position};
  } finally {
    await dawnPage.keyboard.up('KeyW');
  }
  await avatar(duskPage, dawnProfile, {motion:'idle'});
  stage = 'turning on the spot';
  await dawnPage.waitForFunction(() => honeymoon.stats().movementSync.queued === 0);
  const beforeTurn = await stats(dawnPage);
  const wantedYaw = .8;
  await dawnPage.evaluate(yaw => honeymoon.look(yaw, -.2), wantedYaw);
  await duskPage.waitForFunction(({id,yaw}) => honeymoon.players().some(player => player.id === id &&
    player.motion === 'idle' && Math.abs(player.yaw - yaw) < .02 && Math.abs(player.pitch + .2) < .02),
  {id:dawnProfile.id, yaw:wantedYaw}, {timeout:10_000});
  const afterTurn = await stats(dawnPage);
  assert.equal(afterTurn.movementSync.requests, beforeTurn.movementSync.requests);
  assert.deepEqual(afterTurn.position, beforeTurn.position);
  report.turn = {remoteYaw:(await avatar(duskPage,dawnProfile,{motion:'idle'})).yaw, movementRequests:0};
  stage = 'remote flight';
  await enter(duskPage);
  const groundY = (await stats(duskPage)).position.y;
  await duskPage.keyboard.press('KeyF');
  await duskPage.keyboard.down('Space');
  try {
    await dawnPage.waitForFunction(({id, y}) => honeymoon.players().some(player =>
      player.id === id && player.motion === 'fly' && player.position.y > y + .65),
    {id:duskProfile.id, y:groundY}, {timeout:15_000});
  } finally {
    await duskPage.keyboard.up('Space');
  }
  const flight = await avatar(dawnPage, duskProfile, {motion:'fly',wingsExtended:true});
  await aimAt(dawnPage, flight.position);
  await dawnPage.waitForFunction(({id, angle}) => honeymoon.players().some(player =>
    player.id === id && player.onScreen && Math.abs(player.wingAngles[0] - angle) > .22),
  {id:duskProfile.id, angle:flight.wingAngles[0]});
  const flapping = await avatar(dawnPage, duskProfile, {motion:'fly',wingsExtended:true});
  const flightSkinPixels = await captureAvatar(dawnPage, join(output,'iskra-sees-lunny-flying.png'), dusk.type);
  report.flight = {remoteY:flapping.position.y, wingAngles:[flight.wingAngles,flapping.wingAngles], skinPixels:flightSkinPixels};
  await duskPage.keyboard.press('KeyF');
  await duskPage.waitForFunction(y => Math.abs(honeymoon.stats().position.y - y) < .04, groundY);

  stage = 'shared placement and movement corrections';
  await enter(duskPage);
  const buildAt = {x:-10,y:65,z:-20};
  await aimBlock(duskPage, {...buildAt,y:64});
  const copied = await action(duskPage, 'copy', () => duskPage.keyboard.press('KeyQ'));
  const placed = await action(duskPage, 'place', () => duskPage.mouse.click(640,360,{button:'right'}));
  assert.equal(placed.changes[0].cell, copied.cell);
  await dawnPage.waitForFunction(({x,y,z,key}) => {
    const cell = honeymoon.getCell(x,y,z);
    return (typeof cell === 'string' ? cell : cell?.key) === key;
  }, {...buildAt,key:copied.cell}, {timeout:8_000});
  report.effects = {sharedPlacement:placed.changes[0].cell, revision:placed.worldRevision};

  stage = 'skin reset seen by peer';
  await duskPage.evaluate(() => document.exitPointerLock());
  await duskPage.locator('#clear-skin').click();
  await enter(duskPage);
  await dawnPage.waitForFunction(id => honeymoon.players().some(player => player.id === id &&
    player.skin === null && player.meshCount > 4), duskProfile.id, {timeout:10_000});
  await duskPage.evaluate(() => document.exitPointerLock());
  await duskPage.locator('#pony-skin').setInputFiles({name:'pony.png', mimeType:'image/png', buffer:skinPng(dusk)});
  await duskPage.waitForFunction(() => document.querySelector('#skin-status').textContent === 'pony.png');
  await enter(duskPage);
  await avatar(dawnPage, duskProfile, {ponyType:dusk.type});
  report.effects.skinResetAndRestore = true;

  report.movement = [];
  for (const [page, profile] of [[dawnPage,dawnProfile], [duskPage,duskProfile]]) {
    const {movementSync} = await stats(page);
    assert.equal(movementSync.corrections, 0, JSON.stringify(movementSync));
    assert.equal(movementSync.errors, 0, JSON.stringify(movementSync));
    report.movement.push({nickname:profile.nickname, corrections:movementSync.corrections, errors:movementSync.errors});
  }
  stage = 'disconnect and same-profile reconnect';
  await duskPage.close();
  await dawnPage.waitForFunction(id => !honeymoon.players().some(player => player.id === id),
    duskProfile.id, {timeout:20_000});
  const rejoined = await newPage(duskContext);
  assert.equal(await rejoined.locator('#nickname').inputValue(), duskProfile.nickname);
  await enter(rejoined);
  await avatar(dawnPage, duskProfile);
  await avatar(rejoined, dawnProfile);
  report.reconnect = {disappeared:true, sameNickname:true, sameSkin:true, sameId:true};
  assert.deepEqual(report.errors, []);
  await writeFile(join(output,'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failedStage = stage;
  report.errors.push(error.message);
  await writeFile(join(output,'result.json'), JSON.stringify(report, null, 2) + '\n');
  throw new Error(`Multiplayer check failed during ${stage}`, {cause:error});
} finally {
  await browser?.close();
  await app?.close();
}
