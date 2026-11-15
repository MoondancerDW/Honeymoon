import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {once} from 'node:events';
import {mkdir, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import {chromium} from 'playwright-core';
import {loadBase} from '../server/base.mjs';
import {createHoneymoonServer} from '../server/index.mjs';
import * as geometry from '../world/geometry.mjs';

const [generatedArg = 'generated', outputArg = 'work/city-performance/benchmark', ...selected] = process.argv.slice(2);
const generated = resolve(generatedArg);
const output = resolve(outputArg);
const base = loadBase(join(generated, 'world'));
assert.ok(base.manifest.chunkPalettes, 'Import the full city first');
const execute = promisify(execFile);
const mib = value => Math.round(value / 2 ** 20 * 10) / 10;
const round = value => Math.round(value * 10) / 10;
const percentile = (values, p) => values[Math.max(0, Math.ceil(values.length * p) - 1)];
const report = {hash:base.hash, browser:null, gpu:null, cases:[]};
const errors = [];
const corrections = [];
const lodBenchmark = process.env.HONEYMOON_BENCH_LOD === '1';
const occlusion = process.env.HONEYMOON_BENCH_OCCLUSION === '1';
const perspective = process.env.HONEYMOON_BENCH_PERSPECTIVE ?? 'first';
assert.ok(['first','back'].includes(perspective), 'Set benchmark perspective to first or back');
const sprint = process.env.HONEYMOON_BENCH_SPRINT === '1';
const settled = lodBenchmark || process.env.HONEYMOON_BENCH_SETTLED === '1';
const samples = [
  {id:'walk-spawn', feet:base.manifest.spawn, travel:8, walk:true},
  {id:'city-flight', feet:[-175, 115, 39], travel:18},
  {id:'forest-and-castle-flight', feet:[-1720, 125, 166], yaw:-Math.PI / 2, pitch:-.24, travel:18},
  {id:'eastern-slope-flight', feet:[560, 240, -667], travel:13},
  {id:'mine-turn', feet:[612.5,44,667.5], yaw:206.6*Math.PI/180, pitch:-14.3*Math.PI/180, travel:0, walk:true},
  {id:'castle-long-approach', feet:[-1900, 145, 166], yaw:-Math.PI / 2, pitch:-.15, travel:16},
];

function frameSummary(intervals) {
  const values = intervals.toSorted((a,b) => a-b);
  if (!values.length) return null;
  return {count:values.length, meanFps:round(1000 * values.length / values.reduce((a,b) => a+b,0)),
    p50ms:round(percentile(values,.50)),p95ms:round(percentile(values,.95)),p99ms:round(percentile(values,.99)),
    maxMs:round(values.at(-1)), over50ms:values.filter(ms => ms > 50).length};
}

async function windowsProcesses(ids) {
  assert.ok(ids.length && ids.every(value => Number.isInteger(value) && value > 0));
  const command = `@(Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,WorkingSet64,PrivateMemorySize64,CPU) | ConvertTo-Json -Compress`;
  const {stdout} = await execute('powershell.exe', ['-NoProfile','-Command',command], {windowsHide:true});
  const data = JSON.parse(stdout);
  return Array.isArray(data) ? data : [data];
}

async function memory(cdp, tab) {
  const {processInfo} = await cdp.send('SystemInfo.getProcessInfo');
  const {metrics} = await tab.send('Performance.getMetrics');
  const pids = processInfo.map(p => p.id);
  const usage = await windowsProcesses(pids);
  const heap = metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value;
  const gpu = processInfo.find(p => p.type === 'GPU');
  return {
    workingSetMiB:mib(usage.reduce((sum, process) => sum + process.WorkingSet64, 0)),
    privateCommittedMiB:mib(usage.reduce((sum, process) => sum + process.PrivateMemorySize64, 0)),
    gpuProcessPrivateMiB:mib(usage.find(process => process.Id === gpu?.id)?.PrivateMemorySize64 ?? 0),
    tabJSHeapMiB:mib(heap ?? 0),
    cpuSeconds:processInfo.reduce((sum, process) => sum + process.cpuTime, 0),
    browserProcesses:usage.length,
  };
}

async function measure(browser, cdp, sample, width, height, distance) {
  const server = createHoneymoonServer({generated, base:{...base, manifest:{...base.manifest,spawn:sample.feet}},
    state:':memory:',geometry});
  const context = await browser.newContext({viewport:{width,height}, deviceScaleFactor:1});
  const page = await context.newPage();
  const tab = await context.newCDPSession(page);
  const packets = [];
  page.on('pageerror', error => errors.push(`${sample.id}: ${error.message}`));
  page.on('response', res => {
    if (!res.url().endsWith('/api/position')) return;
    packets.push(res.status());
    if (res.status() !== 200) corrections.push({place:sample.id, status:res.status(), body:res.request().postDataJSON()});
  });
  try {
    await tab.send('Performance.enable');
    server.server.listen(0,'127.0.0.1');
    await once(server.server,'listening');
    await page.goto(`http://127.0.0.1:${server.server.address().port}/${occlusion ? '?occlusion=1' : ''}`);
    await page.locator('#play').click({timeout:90_000});
    await page.waitForFunction(() => document.pointerLockElement && globalThis.honeymoon?.stats().playable);
    if (perspective === 'back') await page.keyboard.press('F5');
    await page.waitForFunction(mode => honeymoon.perspective().mode === mode, perspective);
    if (!sample.walk) {
      await page.keyboard.press('KeyF');
      await page.waitForFunction(() => honeymoon.stats().flying);
      const currentY = await page.evaluate(() => honeymoon.stats().position.y);
      if (sample.feet[1] - currentY > 1) {
        await page.keyboard.down('Space');
        try { await page.waitForFunction(y => honeymoon.stats().position.y >= y, sample.feet[1] - 1, {timeout:20_000}); }
        finally { await page.keyboard.up('Space'); }
      }
    }
    await page.evaluate(distance => honeymoon.setDistance(distance), distance);
    if (occlusion) await page.evaluate(() => honeymoon.setOcclusion(true));
    const render = await page.evaluate(() => {
      const gl = document.querySelector('canvas').getContext('webgl2');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    await page.evaluate(({yaw,pitch}) => honeymoon.look(yaw,pitch),{yaw:sample.yaw ?? 0,pitch:sample.pitch ?? 0});
    await page.waitForFunction(({settled,distance,occlusion}) => {
      const {streaming, residentChunks, farTerrain, occlusion:visibility} = honeymoon.stats();
      if (occlusion && (!visibility?.enabled || !visibility.classifiedSections)) return false;
      if (!settled) return streaming && residentChunks >= 40;
      return streaming?.ready && (distance !== 24 || farTerrain?.active && farTerrain.ready && farTerrain.packs > 0);
    }, {settled,distance,occlusion}, {timeout:150_000,polling:250});
    const initial = await page.evaluate(() => honeymoon.stats());
    const before = await memory(cdp, tab);
    const serverBefore = process.memoryUsage();
    await page.evaluate(() => {
      const values = {travel:[],turns:[]};
      window.cityBenchmarkPhase = 'travel';
      let previous = performance.now();
      const track = current => {
        values[window.cityBenchmarkPhase].push(current - previous);
        previous = current;
        window.cityBenchmarkFrame = requestAnimationFrame(track);
      };
      window.cityBenchmarkValues = values;
      window.cityBenchmarkFrame = requestAnimationFrame(track);
    });
    const start = performance.now();
    const traveling = (async () => {
      if (sample.travel) {
        if (sprint) await page.keyboard.down('ShiftLeft');
        await page.keyboard.down('KeyW');
        try { await page.waitForTimeout(sample.travel * 1000); }
        finally {
          await page.keyboard.up('KeyW');
          if (sprint) await page.keyboard.up('ShiftLeft');
        }
      }
      await page.evaluate(() => { window.cityBenchmarkPhase = 'turns'; });
      for (let turn = 0; turn < 12; turn++) {
        const yaw = (sample.yaw ?? 0) + (turn % 2 ? 1.32 : -1.32);
        await page.evaluate(yaw => honeymoon.look(yaw,-.09),yaw);
        await page.waitForTimeout(sample.travel ? 220 : 550);
      }
    })();
    const memoryDuring = [];
    let active = true;
    await Promise.all([traveling.finally(() => { active = false; }), (async () => {
      while (active) {
        await page.waitForTimeout(1500);
        if (active) memoryDuring.push(await memory(cdp, tab));
      }
    })()]);
    const timings = await page.evaluate(() => {
      cancelAnimationFrame(window.cityBenchmarkFrame);
      window.cityBenchmarkValues.travel.shift();
      return window.cityBenchmarkValues;
    });
    const intervals = [...timings.travel,...timings.turns];
    const duration = (performance.now() - start) / 1000;
    const after = await memory(cdp, tab);
    const serverAfter = process.memoryUsage();
    const final = await page.evaluate(() => honeymoon.stats());
    const traveled = Math.hypot(final.position.x - initial.position.x, final.position.z - initial.position.z);
    assert.ok(intervals.length > 100, `${sample.id}, only ${intervals.length} frames`);
    if (sample.travel) assert.ok(traveled > (sample.walk ? 4 : 18), `${sample.id} traveled ${round(traveled)} blocks from ${JSON.stringify(initial.position)} to ${JSON.stringify(final.position)}`);
    assert.equal(final.movementSync.errors - initial.movementSync.errors, 0, sample.id);
    await page.evaluate(({yaw,pitch}) => honeymoon.look(yaw,pitch),{yaw:sample.yaw ?? 0,pitch:sample.pitch ?? 0});
    await page.screenshot({path:join(output,`${sample.id}-${height}-${distance}.png`)});
    return {place:sample.id, resolution:`${width}×${height}`, distance, render, settled, occlusion, perspective, sprint,
      startupMs:round(initial.playable), seconds:round(duration), from:initial.position, to:final.position,
      chunksFetched:final.chunksLoaded - initial.chunksLoaded, residentChunks:final.residentChunks,
      triangles:final.triangles, drawCalls:final.calls, meshBufferMiB:mib(final.preciseBytes),
      lodStart:initial.farTerrain, lodEnd:final.farTerrain, occlusionEnd:final.occlusion,
      frames:frameSummary(intervals), movingFrames:sample.travel ? frameSummary(timings.travel) : null,
      turnFrames:frameSummary(timings.turns),
      memory:{before,after,peakWorkingSetMiB:Math.max(before.workingSetMiB,after.workingSetMiB,...memoryDuring.map(row => row.workingSetMiB)),
        peakPrivateCommittedMiB:Math.max(before.privateCommittedMiB,after.privateCommittedMiB,...memoryDuring.map(row => row.privateCommittedMiB)),
        peakTabJSHeapMiB:Math.max(before.tabJSHeapMiB,after.tabJSHeapMiB,...memoryDuring.map(row => row.tabJSHeapMiB)),
        browserCpuPercentOneCore:round(100 * (after.cpuSeconds - before.cpuSeconds) / duration),
        serverAndHarnessRssMiB:mib(Math.max(serverBefore.rss,serverAfter.rss))},
      corrections:final.movementSync.corrections - initial.movementSync.corrections,
      validPositionPackets:packets.filter(status => status === 200).length};
  } finally {
    await context.close();
    await server.close();
  }
}

await mkdir(output,{recursive:true});
const browser = await chromium.launch({channel:'msedge', headless:process.env.HONEYMOON_HEADED !== '1', args:['--disable-features=msEdgeSidebarV2']});
try {
  report.browser = browser.version();
  const cdp = await browser.newBrowserCDPSession();
  report.gpu = (await cdp.send('SystemInfo.getInfo')).gpu;
  const cases = lodBenchmark ? [
    [1280,720,4,[samples[0],samples[1],samples[5],samples[4]]],
    [1280,720,24,[samples[0],samples[1],samples[5],samples[4]]],
  ] : [
    [1280,720,4,[samples[0],samples[1]]],
    [1280,720,8,samples],
    [1920,1080,8,[samples[1],samples[2]]],
  ];
  for (const [width,height,distance,routes] of cases) for (const sample of routes) {
    if (selected.length && !selected.includes(`${sample.id}:${height}:${distance}`)) continue;
    const test = await measure(browser,cdp,sample,width,height,distance);
    report.cases.push(test);
    await writeFile(join(output,'benchmark.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(test));
  }
  assert.ok(report.cases.length, 'No benchmark case matched');
  assert.deepEqual(errors, []);
} catch (error) {
  report.failure = error.stack;
  throw error;
} finally {
  report.errors = errors;
  report.rejectedPositionPackets = corrections;
  await writeFile(join(output,'benchmark.json'),JSON.stringify(report,null,2)+'\n');
  await browser.close();
}
