import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {loadBase} from '../server/base.mjs';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';

const output = process.argv[2] ?? 'work/seating/browser';
const generated = process.env.HONEYMOON_GENERATED ?? 'generated';
const source = loadBase(join(generated,'world'));
const spawn = [-31.5, 65, -61.5];
const base = {...source, manifest:{...source.manifest, spawn}};
const app = createHoneymoonServer({base, geometry, generated, state:':memory:'});
const chair = {x:-34, y:65, z:-61};
const lamp = {x:-36, y:67, z:-61};
const facing = {yaw:0, pitch:0};
const errors = [];
let origin, browser;

async function enter(name) {
  const context = await browser.newContext({viewport:{width:1280,height:720}});
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.locator('#play:enabled').waitFor({timeout:90000});
  await page.locator('#nickname').fill(name);
  await page.bringToFront();
  await page.locator('#play').click();
  await page.waitForFunction(() => document.querySelector('#entry').hidden);
  await page.waitForFunction(nickname => document.querySelector('#player-name').textContent === nickname, name);
  return page;
}

async function aim(page, position) {
  await page.evaluate(({x,y,z}) => {
    const feet = honeymoon.stats().position;
    const dx = x - feet.x, dy = y - feet.y - 1.62, dz = z - feet.z;
    honeymoon.look(Math.atan2(-dx,-dz),Math.atan2(dy,Math.hypot(dx,dz)));
  }, position);
}

async function faceCell(page, cell, position = {x:cell.x + .5,y:cell.y + .55,z:cell.z + .5}) {
  await aim(page, position);
  await page.waitForFunction(({x,y,z}) => {
    const target = honeymoon.target();
    return target?.x === x && target.y === y && target.z === z;
  }, cell, {timeout:5000});
  return page.evaluate(() => honeymoon.target().hit);
}

async function request(page, path, body) {
  const result = await page.request.post(origin + '/api/' + path, {data:body});
  return {status:result.status(), body:await result.json()};
}

const inspect = page => page.evaluate(() => honeymoon.stats());
const rightClick = page => page.mouse.click(640, 360, {button:'right'});

try {
  await mkdir(output,{recursive:true});
  app.server.listen(0,'127.0.0.1');
  await once(app.server,'listening');
  origin = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({channel:'msedge', headless:process.env.HONEYMOON_HEADED !== '1',
    args:['--disable-renderer-backgrounding','--disable-background-timer-throttling','--disable-backgrounding-occluded-windows']});
  const guest = await enter('Сидящая Пони');
  const observer = await enter('Наблюдатель');
  await guest.waitForFunction(() => honeymoon.players().length === 1);
  await guest.bringToFront();
  await faceCell(guest,chair,{x:-33.5,y:66,z:-60.5});
  const seatRequests = [];
  guest.on('request', request => { if (request.url().endsWith('/api/seat')) seatRequests.push(request); });
  await rightClick(guest);
  assert.equal((await inspect(guest)).seat,null);
  assert.equal(seatRequests.length,0);
  const hit = await faceCell(guest,chair,{x:-33.5,y:66,z:-60.5});
  const seatedResponse = guest.waitForResponse(response => response.url().endsWith('/api/seat'));
  await guest.keyboard.press('KeyE');
  const seated = await seatedResponse;
  assert.equal(seated.status(),200,await seated.text());
  await guest.waitForFunction(() => honeymoon.stats().seat);
  const afterSit = await inspect(guest);
  assert.deepEqual(afterSit.position,{x:-33.5,y:65.5,z:-60.5});
  assert.equal(await guest.locator('#seat-status').isVisible(),true);

  const duplicate = await request(observer,'seat',{...facing,target:{...chair,hit}});
  assert.equal(duplicate.status,409,JSON.stringify(duplicate));
  assert.equal(duplicate.body.error,'seat_taken');
  const forgedMove = await request(guest,'position',{...afterSit.position,x:afterSit.position.x + .3});
  assert.equal(forgedMove.status,409,JSON.stringify(forgedMove));
  assert.deepEqual(forgedMove.body.position,afterSit.position);
  await guest.keyboard.down('KeyW');
  await guest.keyboard.press('KeyF');
  await guest.waitForTimeout(325);
  await guest.keyboard.up('KeyW');
  assert.deepEqual((await inspect(guest)).position,afterSit.position);
  assert.equal((await inspect(guest)).flying,false);

  await observer.bringToFront();
  await aim(observer,{x:-33.5,y:66.35,z:-60.5});
  await observer.waitForFunction(() => honeymoon.players().some(player => player.motion === 'sit' && player.visible &&
    player.onScreen && player.legAngles[2] < -1.4 && player.legAngles[0] < -.35));
  const visiblePony = await observer.evaluate(() => honeymoon.players()[0]);
  await observer.screenshot({path:join(output,'sitting-pony.png')});

  await guest.bringToFront();
  await rightClick(guest);
  assert.ok((await inspect(guest)).seat);
  assert.equal(seatRequests.length,1);
  const standingResponse = guest.waitForResponse(response => response.url().endsWith('/api/seat'));
  await guest.keyboard.press('KeyE');
  const standing = await standingResponse;
  assert.equal(standing.status(),200,await standing.text());
  await guest.waitForFunction(() => honeymoon.stats().seat === null);
  const afterStand = (await inspect(guest)).position;
  assert.ok(spawn.every((coordinate,index) => Math.abs(coordinate - Object.values(afterStand)[index]) < 1e-4), JSON.stringify(afterStand));
  await observer.waitForFunction(() => honeymoon.players().length === 1 && honeymoon.players()[0].motion !== 'sit');

  await faceCell(guest,lamp,{x:-35.5,y:67.55,z:-60.685});
  const interactions = [];
  guest.on('request', request => {
    if (request.url().endsWith('/api/action') && request.postDataJSON().type === 'interact') interactions.push(request);
  });
  await rightClick(guest);
  await guest.waitForTimeout(300);
  assert.equal(interactions.length,0);
  await faceCell(guest,lamp,{x:-35.5,y:67.55,z:-60.685});
  const eResponse = guest.waitForResponse(response => response.url().endsWith('/api/action') &&
    response.request().postDataJSON()?.type === 'interact');
  await guest.keyboard.press('KeyE');
  const lampEffect = await eResponse;
  assert.equal(lampEffect.status(),200,await lampEffect.text());
  assert.ok((await lampEffect.json()).changes.some(change => change.cell === 'legacy:219:5'));
  assert.equal(interactions.length,1);

  const result = {browser:browser.version(), chair, position:afterSit.position, seatedAngles:visiblePony.legAngles,
    sameSeatDenied:duplicate.body.error, walkingAndFlightLocked:true, satAndStoodByKeyE:true, rightClickDidNotUse:true, lampByKeyE:true,
    correctionCount:(await inspect(guest)).movementSync.corrections, errors};
  assert.equal(result.correctionCount,0,JSON.stringify(result));
  assert.deepEqual(errors,[]);
  await writeFile(join(output,'result.json'),JSON.stringify(result,null,2) + '\n');
  console.log(JSON.stringify(result,null,2));
} finally {
  await browser?.close();
  await app.close();
}
