import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {crc32, deflateSync} from 'node:zlib';
import {chromium} from 'playwright-core';
import {loadBase} from '../server/base.mjs';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';
import {isRideableMinecart} from '../world/minecarts.mjs';
import {GROUND_SPRINT_SPEED, WALK_SPEED} from '../world/player-body.mjs';
import {defaultPonyPixels} from '../world/pony-skins.mjs';

const output = process.argv[2] ?? 'work/perspective-desktop';
const spawn = [-8.5,65,-20.5];
const source = loadBase('generated/world');
const base = {...source, manifest:{...source.manifest, spawn}};
const app = createHoneymoonServer({base, geometry, state:':memory:'});
const report = {browser:null, camera:[], speeds:{}, seats:[], errors:[]};
let browser, page, stage = 'startup';

function skin(mark) {
  function chunk(name, data) {
    const content = Buffer.concat([Buffer.from(name),data]);
    const size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(content));
    return Buffer.concat([size,content,crc]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(64,0);
  header.writeUInt32BE(32,4);
  header[8] = 8;
  header[9] = 6;
  const pixels = defaultPonyPixels();
  pixels.set([...mark,255]);
  const rows = Buffer.alloc(257 * 32);
  for (let row = 0; row < 32; row++) rows.set(pixels.subarray(256 * row, 256 * (row + 1)), 257 * row + 1);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}

async function chooseSkin(name, marker) {
  await page.locator('#pony-skin').setInputFiles({name,mimeType:'image/png',buffer:skin(marker)});
  await page.waitForFunction(name => document.querySelector('#skin-status').textContent === name,name);
  await page.locator('#play').click();
  await page.waitForFunction(() => document.querySelector('#entry').hidden);
}

async function camera(mode, image) {
  await page.keyboard.press('F5');
  await page.waitForFunction(mode => honeymoon.perspective().mode === mode,mode);
  // The key changes the mode immediately, and the render loop moves the camera on the next frame.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const view = await page.evaluate(() => ({...honeymoon.perspective(),avatar:honeymoon.localAvatar()}));
  if (image) await page.screenshot({path:join(output,image)});
  report.camera.push(view);
  return view;
}

async function teleport(feet) {
  await page.keyboard.press('KeyG');
  await page.locator('#teleport-form').waitFor();
  for (const [i,axis] of ['x','y','z'].entries()) await page.locator(`#teleport-${axis}`).fill(String(feet[i]));
  const result = page.waitForResponse(response => response.url().endsWith('/api/teleport'));
  await page.locator('#teleport-send').click();
  const response = await result;
  assert.equal(response.status(),200,await response.text());
  await page.locator('#teleport-close').click();
  await page.waitForFunction(() => document.querySelector('#entry').hidden);
  await page.waitForFunction(feet => Object.values(honeymoon.stats().position).every((value,i) =>
    Math.abs(value - feet[i]) < .003),feet);
}

const look = (yaw,pitch = 0) => page.evaluate(([yaw,pitch]) => honeymoon.look(yaw,pitch),[yaw,pitch]);

async function move(name,motion,sprint,image) {
  if (sprint) await page.keyboard.down('Shift');
  await page.keyboard.down('KeyW');
  try {
    await page.waitForFunction(motion => honeymoon.localAvatar()?.motion === motion,motion);
    const measure = () => page.evaluate(() => ({t:performance.now(),position:honeymoon.stats().position,
      avatar:honeymoon.localAvatar()}));
    const before = await measure();
    await page.waitForTimeout(460);
    const after = await measure();
    if (image) await page.screenshot({path:join(output,image)});
    const distance = Math.hypot(after.position.x - before.position.x,after.position.z - before.position.z);
    report.speeds[name] = {speed:distance * 1000 / (after.t - before.t),distance,motion,
      pose:after.avatar,phaseChanged:before.avatar.phase !== after.avatar.phase};
  } finally {
    await page.keyboard.up('KeyW');
    if (sprint) await page.keyboard.up('Shift');
  }
}

async function sit(name,feet,cell,hit,expected,cart = false) {
  await teleport(feet);
  await page.evaluate(({x,y,z}) => {
    const feet = honeymoon.stats().position;
    const dx = x - feet.x, dy = y - feet.y - 1.62, dz = z - feet.z;
    honeymoon.look(Math.atan2(-dx,-dz),Math.atan2(dy,Math.hypot(dx,dz)));
  },hit);
  if (cart) await page.waitForFunction(() => document.querySelector('#selected').textContent.includes('Вагонетка'));
  else {
    await page.waitForFunction(cell => {
      const target = honeymoon.target();
      return target && [target.x,target.y,target.z].every((value,i) => value === cell[i]);
    },cell);
  }
  const result = page.waitForResponse(response => response.url().endsWith('/api/seat'));
  await page.keyboard.press('KeyE');
  const response = await result;
  assert.equal(response.status(),200,await response.text());
  await page.waitForFunction(() => {
    const avatar = honeymoon.localAvatar();
    return avatar?.motion === 'sit' && avatar.legAngles[2] < -1.4 && avatar.legAngles[0] < -.35;
  });
  const seated = await page.evaluate(() => ({position:honeymoon.stats().position,avatar:honeymoon.localAvatar(),
    camera:honeymoon.perspective()}));
  assert.deepEqual(Object.values(seated.position),expected);
  await look(seated.avatar.yaw,.09);
  const front = await camera('front',`seated-${name}.png`);
  assert.ok(front.distance > 1 && front.avatar.visible);
  await camera('first');
  await camera('back');
  await page.keyboard.press('KeyE');
  await page.waitForFunction(() => honeymoon.stats().seat === null);
  report.seats.push({name,cell,...seated,front});
}

try {
  await mkdir(output,{recursive:true});
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  browser = await chromium.launch({channel:'msedge',headless:process.env.HONEYMOON_HEADED !== '1',
    args:['--disable-renderer-backgrounding','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows']});
  report.browser = browser.version();
  page = await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',error => report.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}`);
  await page.locator('#play:enabled').waitFor({timeout:90_000});
  await page.locator('#nickname').fill('Пони Камера');
  await chooseSkin('pegasus.png',[136,202,240]);
  await page.evaluate(() => honeymoon.setDistance(4));
  await look(Math.PI / 2);

  stage = 'camera cycle and skin';
  assert.equal(await page.evaluate(() => honeymoon.perspective().mode),'first');
  await page.waitForFunction(() => {
    const avatar = honeymoon.localAvatar();
    return avatar?.visible === true && avatar.firstPersonBody && avatar.firstPersonHooves?.length === 2;
  });
  await camera('back');
  await page.waitForFunction(() => {
    const avatar = honeymoon.localAvatar();
    return avatar?.visible && avatar.skinReady && avatar.ponyType === 'pegasus';
  });
  await page.screenshot({path:join(output,'back.png')});
  const front = await camera('front','front.png');
  assert.ok(front.distance > 3.6 && front.avatar.visible);
  await camera('first','first.png');
  assert.equal(await page.evaluate(() => honeymoon.localAvatar()?.firstPersonBody),true);
  await camera('back');

  stage = 'walk, sprint and flight';
  await move('walk','walk',false,'walk.png');
  await move('run','run',true,'run.png');
  assert.ok(report.speeds.walk.phaseChanged && report.speeds.run.phaseChanged);
  const runRatio = report.speeds.run.speed / report.speeds.walk.speed;
  assert.ok(Math.abs(runRatio - GROUND_SPRINT_SPEED / WALK_SPEED) < .22,JSON.stringify(report.speeds));
  await page.keyboard.press('KeyF');
  await teleport([-7.5,83,-19.5]);
  await look(Math.PI / 2,-.05);
  await move('flight','fly',false,'flight.png');
  await move('flightSprint','fly',true);
  assert.equal(report.speeds.flight.pose.wingsExtended,true);
  const flightRatio = report.speeds.flightSprint.speed / report.speeds.flight.speed;
  assert.ok(flightRatio > 1.75 && flightRatio < 2.25,JSON.stringify(report.speeds));
  await page.keyboard.press('KeyF');

  stage = 'actual armchair and bed';
  await sit('armchair',[-31.5,65,-61.5],[-34,65,-61],{x:-33.5,y:66,z:-60.5},[-33.5,65.5,-60.5]);
  await sit('bed',[-31.5,75,-69.5],[-33,74,-72],{x:-32.5,y:74.5625,z:-71.5},[-32.5,74.5625,-71.5]);
  assert.ok(report.seats.some(entry => entry.camera.distance < 4),'Camera should retract near actual furniture walls');

  stage = 'actual imported passenger cart';
  const cart = source.publicChunk(30,-28).entities.find(isRideableMinecart);
  assert.ok(cart);
  const [x,y,z] = cart.position;
  await page.keyboard.press('KeyF');
  await sit('minecart',[491.5,157.5,-442.5],cart.position.map(Math.floor),{x,y:y-.1,z},[x,y-3/16,z],true);

  stage = 'skin change in the same session';
  await page.evaluate(() => document.exitPointerLock());
  await page.locator('#play:enabled').waitFor();
  await chooseSkin('unicorn.png',[209,159,228]);
  await page.waitForFunction(() => {
    const avatar = honeymoon.localAvatar();
    return avatar?.skinReady && avatar.ponyType === 'unicorn';
  });
  assert.equal(await page.locator('#player-name').textContent(),'Пони Камера');
  report.changedSkin = await page.evaluate(() => honeymoon.localAvatar());
  report.movement = await page.evaluate(() => honeymoon.stats().movementSync);
  assert.equal(report.movement.corrections,0,JSON.stringify(report.movement));
  assert.deepEqual(report.errors,[]);
  console.log(JSON.stringify(report,null,2));
} catch (error) {
  report.failed = stage;
  await page?.screenshot({path:join(output,'failed.png')}).catch(() => {});
  throw new Error(`Perspective desktop QA failed at ${stage}`,{cause:error});
} finally {
  await writeFile(join(output,'result.json'),JSON.stringify(report,null,2) + '\n');
  await browser?.close();
  app.close();
}
