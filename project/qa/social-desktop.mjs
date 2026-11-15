import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';

const output = process.argv[2] ?? 'work/social-desktop';
const external = process.env.HONEYMOON_TEST_URL;
const rendered = Number(process.env.HONEYMOON_QA_RENDERERS ?? 2);
assert.ok(rendered >= 2 && rendered <= 8);
const app = external ? null : createHoneymoonServer({state:':memory:', geometry});
const clients = [];
const report = {errors:[]};
let browser, url;
let stage = 'startup';

async function joinPlayer(nickname) {
  const context = await browser.newContext({viewport:{width:1024,height:640}, ignoreHTTPSErrors:true});
  const page = await context.newPage();
  clients.push({context,page,nickname});
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  await page.goto(url);
  try {
    await page.waitForFunction(() => globalThis.honeymoon && !document.querySelector('#play').disabled,
      null, {timeout:120000});
  } catch (error) {
    report.startup = await page.evaluate(() => ({loading:document.querySelector('#loading')?.textContent,
      stats:globalThis.honeymoon?.stats() && Object.fromEntries(['calls','triangles','chunksLoaded','pending','loaded']
        .map(key => [key, honeymoon.stats()[key]]))}));
    throw error;
  }
  await page.evaluate(() => honeymoon.setDistance(4));
  await page.bringToFront();
  await page.locator('#nickname').fill(nickname);
  await page.locator('#play').click();
  await page.waitForFunction(nick => honeymoon.online().includes(nick), nickname, {timeout:20000});
  assert.equal(await page.locator('#nickname').evaluate(input => input.readOnly), true);
  return page;
}

async function joinProtocolPlayer(nickname) {
  const context = await browser.newContext({ignoreHTTPSErrors:true});
  const page = await context.newPage();
  clients.push({context, page, nickname, protocol:true});
  await page.route(url + '/qa-peer', route => route.fulfill({contentType:'text/html', body:'<!doctype html><title>Honeymoon peer</title>'}));
  await page.goto(url + '/qa-peer');
  await page.evaluate(async name => {
    async function post(path, body) {
      const response = await fetch('/api/' + path, {method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify(body)});
      if (!response.ok) throw new Error(`${path} ${response.status}`);
      return response.json();
    }
    await post('session', {});
    await post('profile', {nickname:name});
    const feed = new EventSource('/api/events?presence=1&social=1');
    globalThis.roster = [];
    feed.addEventListener('presence', event => {
      const {players, selfOnline} = JSON.parse(event.data);
      globalThis.roster = [...players.map(player => player.nickname), ...(selfOnline ? [name] : [])];
    });
    await new Promise((resolve, reject) => {
      feed.addEventListener('open', resolve, {once:true});
      feed.addEventListener('error', reject, {once:true});
    });
    await post('presence', {yaw:0, pitch:0, motion:'idle'});
  }, nickname);
  await page.waitForFunction(name => globalThis.roster.includes(name), nickname);
}

async function setTime(page, time, frozen) {
  if (!await page.locator('#clock-form').isVisible()) await page.keyboard.press('KeyK');
  await page.locator('#clock-input').fill(time);
  await page.locator('#clock-frozen').setChecked(frozen);
  await page.locator('#clock-form button[type=submit]').click();
  await page.waitForFunction(({time,frozen}) => (!frozen || document.querySelector('#clock-toggle').textContent === time) &&
    honeymoon.time().frozen === frozen, {time,frozen});
}

async function lookAtSky(page, lunar) {
  await page.evaluate(moon => {
    document.activeElement?.blur();
    const [x,y,z] = honeymoon.time().sun.map(value => moon ? -value : value);
    honeymoon.look(Math.atan2(-x,-z), Math.asin(y));
  }, lunar);
  await page.waitForTimeout(150);
}

try {
  await mkdir(output, {recursive:true});
  if (app) {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    url = `http://127.0.0.1:${app.server.address().port}`;
  } else url = new URL(external).origin;
  browser = await chromium.launch({channel:'msedge', args:['--disable-background-timer-throttling',
    '--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
  report.browser = browser.version();
  report.renderedClients = rendered;
  for (let i = 1; i <= 8; i++) {
    stage = `join player ${i}`;
    if (i === 1 || i > 9 - rendered) await joinPlayer(`Пони-${i}`);
    else await joinProtocolPlayer(`Пони-${i}`);
    console.log(stage);
  }
  const first = clients[0].page, last = clients.at(-1).page;
  const everyone = clients.map(player => player.nickname);
  await Promise.all(clients.map(({page,protocol}) => page.waitForFunction(({expected,protocol}) => {
    const names = protocol ? globalThis.roster : honeymoon.online();
    return names.length === expected.length && expected.every(name => names.includes(name)) &&
      (protocol || honeymoon.players().length === 7);
  }, {expected:everyone, protocol}, {timeout:40000})));
  report.players = everyone;

  stage = 'Tab roster';
  await last.bringToFront();
  await last.keyboard.down('Tab');
  try {
    await last.locator('#online').waitFor({state:'visible'});
    assert.deepEqual(await last.locator('#online-names li').allTextContents(), everyone);
    await last.screenshot({path:join(output, 'eight-online.png')});
  } finally { await last.keyboard.up('Tab'); }
  await last.locator('#online').waitFor({state:'hidden'});
  stage = 'send chat message';
  await last.keyboard.press('KeyT');
  await last.locator('#chat-input').fill('Привет, все восемь! <b>текст</b>');
  await last.locator('#chat-input').press('Enter');
  await first.waitForFunction(() => document.querySelector('#chat-log').textContent.includes('Пони-8  Привет, все восемь! <b>текст</b>'));
  assert.equal(await first.locator('#chat-log b').count(), 0);
  await last.locator('#chat-channel').click();
  assert.equal(await last.locator('#chat-channel').getAttribute('aria-pressed'), 'true');
  assert.equal(await last.locator('#local-chat-log').evaluate(log => log.hidden), false);
  assert.equal(await last.locator('#chat-log').evaluate(log => log.hidden), true);
  await last.locator('#chat-input').fill('Эту фразу слышно рядом');
  await last.locator('#chat-input').press('Enter');
  await last.locator('#local-chat-log li').filter({hasText:'Эту фразу слышно рядом'}).waitFor({state:'visible'});
  await first.waitForFunction(() => document.querySelector('#local-chat-log').textContent.includes('Пони-8  Эту фразу слышно рядом'));
  assert.doesNotMatch(await first.locator('#chat-log').textContent(), /Эту фразу слышно рядом/);
  await last.locator('#chat-channel').click();
  assert.equal(await last.locator('#chat-channel').getAttribute('aria-pressed'), 'false');
  await last.locator('#chat-close').click();
  await last.waitForFunction(() => document.pointerLockElement);
  report.chat = {remoteMessage:true, escapedHTML:true, localMessage:true, channelToggle:true, resumed:true};

  stage = 'coordinate teleport';
  const home = await last.evaluate(() => honeymoon.stats().position);
  await last.keyboard.press('KeyF');
  await last.waitForFunction(() => honeymoon.stats().flying);
  await last.keyboard.press('KeyG');
  await last.locator('#teleport-form').waitFor({state:'visible'});
  const setDestination = async target => {
    for (const axis of ['x','y','z']) await last.locator(`#teleport-${axis}`).fill(String(target[axis]));
    await last.locator('#teleport-send').click();
    await last.waitForFunction(position => {
      const actual = honeymoon.stats().position;
      return Math.hypot(actual.x - position.x, actual.y - position.y, actual.z - position.z) < .04;
    }, target);
  };
  const high = {...home,y:200};
  await setDestination(high);
  await first.waitForFunction(y => honeymoon.players().some(player => player.nickname === 'Пони-8' &&
    Math.abs(player.position.y - y) < .1), high.y);
  await setDestination(home);
  await last.locator('#teleport-close').click();
  await last.waitForFunction(() => document.pointerLockElement);
  await last.keyboard.press('KeyF');
  report.teleport = {coordinates:true, peerPosition:true, returned:true};

  stage = 'clock controls';
  await setTime(last, '21:45', true);
  await first.waitForFunction(() => honeymoon.time().frozen && honeymoon.time().tick === 15750);
  await lookAtSky(last, true);
  await last.screenshot({path:join(output, 'moon-and-stars.png')});
  await setTime(last, '09:45', true);
  await first.waitForFunction(() => honeymoon.time().frozen && honeymoon.time().tick === 3750);
  await lookAtSky(last, false);
  await last.screenshot({path:join(output, 'round-sun.png')});
  await setTime(last, '12:00', false);
  await first.waitForFunction(() => !honeymoon.time().frozen && honeymoon.time().tick > 6010);
  await last.locator('#clock-close').click();
  report.clock = {remoteFreeze:true, remoteSet:true, remoteResume:true};

  stage = 'logout notification';
  assert.match(await last.locator('#coords').textContent(), /X -?\d+\.\d\d\s+Y -?\d+\.\d\d\s+Z -?\d+\.\d\d/);
  await clients.at(-1).context.close();
  await first.waitForFunction(() => honeymoon.online().length === 7 &&
    document.querySelector('#chat-log').textContent.includes('Пони-8 выходит из игры'));
  assert.ok((await first.locator('#chat-log').textContent()).includes('Пони-8 входит в игру'));
  report.chat.joinAndLeave = true;
  report.corrections = await Promise.all(clients.filter(client => !client.protocol && !client.page.isClosed())
    .map(({page}) => page.evaluate(() => honeymoon.stats().movementSync.corrections)));
  assert.ok(report.corrections.every(count => count === 0));
  assert.deepEqual(report.errors, []);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.failure = error.stack;
  report.stage = stage;
  throw error;
} finally {
  await writeFile(join(output,'result.json'), JSON.stringify(report, null, 2) + '\n');
  await browser?.close();
  await app?.close();
}
