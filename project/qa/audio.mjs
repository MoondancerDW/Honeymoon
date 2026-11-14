import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {loadBase} from '../server/base.mjs';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';

const base = loadBase('generated/world');
const app = createHoneymoonServer({state: ':memory:', geometry,
  base: {...base, manifest: {...base.manifest, spawn: [-30.5, 65, -57.5]}}});
let browser;
try {
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  browser = await chromium.launch({channel: 'msedge'});
  const page = await browser.newPage({viewport: {width: 1280, height: 720}});
  const recording = [];
  let sampleRate = 48_000;
  await page.exposeBinding('qaRecordAudio', (_, frame) => {
    sampleRate = frame.sampleRate;
    recording.push(Int16Array.from(frame.pcm));
  });
  await page.addInitScript(() => {
    const AudioContext = window.AudioContext;
    if (!AudioContext) return;
    window.AudioContext = class extends AudioContext {
      constructor(...args) {
        super(...args);
        const context = this;
        const createGain = this.createGain.bind(this);
        const recording = context.createScriptProcessor(2048, 2, 2);
        recording.onaudioprocess = event => {
          if (window.qaCaptureAudio === false) return;
          const left = event.inputBuffer.getChannelData(0), right = event.inputBuffer.getChannelData(1);
          const pcm = Array.from(left, (_, index) => Math.round(Math.max(-1, Math.min(1,
            (left[index] + right[index]) / 2)) * 32767));
          void window.qaRecordAudio({sampleRate: context.sampleRate, pcm});
        };
        recording.connect(context.destination);
        this.createGain = () => {
          const gain = createGain();
          const connect = gain.connect.bind(gain);
          gain.connect = (output, ...ports) => {
            if (output === context.destination) connect(recording);
            return connect(output, ...ports);
          };
          return gain;
        };
      }
    };
  });
  const audioFiles = [];
  const errors = [];
  page.on('response', response => {
    if (!response.url().endsWith('.ogg')) return;
    audioFiles.push({url: response.url(), type: response.headers()['content-type'], status: response.status()});
  });
  page.on('pageerror', error => errors.push(error.message));
  const manifest = await (await fetch(`${origin}/generated/sounds/sounds.json`)).json();
  await page.goto(origin);
  await page.waitForFunction(() => globalThis.honeymoon?.stats().audio.loaded && !document.querySelector('#play').disabled, null, {timeout: 90_000});
  assert.equal((await page.evaluate(() => honeymoon.stats().audio)).state, 'disabled');
  await page.locator('#play').click();
  await page.waitForFunction(() => honeymoon.stats().audio.state === 'running' && document.querySelector('#entry').hidden);

  await page.evaluate(() => honeymoon.look(0, -.12));
  await page.waitForFunction(() => honeymoon.target()?.x === -31 && honeymoon.target()?.z === -59);
  await page.keyboard.press('KeyE');
  const door = manifest.sounds['door.open'][0];
  await page.waitForFunction(() => honeymoon.stats().audio.played >= 1);
  assert.ok(audioFiles.some(entry => entry.url.endsWith(door) && entry.status === 200 && entry.type === 'audio/ogg'));

  await page.keyboard.down('KeyW');
  await page.waitForFunction(() => honeymoon.stats().position.z < -59.5 && honeymoon.stats().audio.played >= 2, null, {timeout: 12_000});
  await page.keyboard.up('KeyW');
  await page.waitForTimeout(300);
  await page.evaluate(() => {window.qaCaptureAudio = false;});
  const steps = Object.entries(manifest.sounds).filter(([id]) => id.startsWith('step.')).flatMap(([, files]) => files);
  assert.ok(audioFiles.some(entry => steps.some(file => entry.url.endsWith(file))));

  await page.evaluate(() => document.exitPointerLock());
  await page.locator('#reset').click();
  await page.waitForFunction(() => honeymoon.stats().position.z === -57.5);
  await page.locator('#audio-toggle').click();
  await page.locator('#play').click();
  await page.waitForFunction(() => honeymoon.stats().audio.muted && document.querySelector('#entry').hidden);
  await page.evaluate(() => honeymoon.look(.39, -.12));
  await page.waitForFunction(() => honeymoon.target()?.x === -31 && honeymoon.target()?.z === -59, null, {timeout: 4000});
  const beforeMuted = await page.evaluate(() => honeymoon.stats().audio.played);
  await page.keyboard.press('KeyE');
  await page.waitForFunction(() => {
    const cell = honeymoon.getCell(-31, 65, -59);
    return (typeof cell === 'string' ? cell : cell?.key) === 'legacy:64:3';
  });
  const afterMuted = await page.evaluate(() => honeymoon.stats().audio);
  assert.equal(afterMuted.played, beforeMuted);
  assert.equal(afterMuted.musicPlaying, false);
  await page.evaluate(() => document.exitPointerLock());
  await page.locator('#audio-toggle').click();
  await page.locator('#music-toggle').click();
  await page.locator('#play').click();
  await page.waitForFunction(() => honeymoon.stats().audio.musicPlaying);
  const music = manifest.sounds['music.overworld'];
  assert.ok(audioFiles.some(entry => music.some(file => entry.url.endsWith(file))));
  await page.evaluate(() => document.exitPointerLock());
  await page.locator('#music-toggle').click();
  assert.equal((await page.evaluate(() => honeymoon.stats().audio)).musicPlaying, false);
  assert.deepEqual(errors, []);
  const result = {browser: browser.version(), audio: afterMuted, samples: audioFiles.map(entry => entry.url.split('/').pop()),
    checks: ['gesture unlock', 'original door and footstep Ogg decoded and played', 'muted door action remains functional',
      'optional music starts with the configured pack and stops when switched off']};
  await mkdir('work/audio-registry', {recursive: true});
  const frames = recording.flatMap(frame => Array.from(frame));
  const audible = frames.findIndex(frame => Math.abs(frame) > 2);
  assert.ok(audible >= 0, 'Measured Web Audio output contains no audible samples');
  const first = Math.max(0, audible - Math.round(sampleRate * .15));
  const pcm = frames.slice(first);
  const wav = Buffer.alloc(44 + 2 * pcm.length);
  wav.write('RIFF');
  wav.writeUInt32LE(36 + pcm.length * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(pcm.length * 2, 40);
  for (let i = 0; i < pcm.length; i++) wav.writeInt16LE(pcm[i], 44 + i * 2);
  await writeFile('work/audio-registry/browser-door-and-steps.wav', wav);
  await writeFile('work/audio-registry/browser-audio.json', JSON.stringify(result, null, 2) + '\n');
  console.log(result);
} finally {
  await browser?.close();
  await app.close();
}
