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

const [generatedArg = 'generated', outputArg = 'work/city-performance/benchmark'] = process.argv.slice(2);
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
const samples = [
  {id:'walk-spawn', feet:base.manifest.spawn, travel:8, walk:true},
  {id:'city-flight', feet:[-175, 115, 39], travel:18},
  {id:'forest-and-castle-flight', feet:[-1720, 125, 166], yaw:-Math.PI / 2, pitch:-.24, travel:18},
  {id:'eastern-slope-flight', feet:[560, 240, -667], travel:13},
];

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
    await page.goto(`http://127.0.0.1:${server.server.address().port}`);
    await page.locator('#play').click({timeout:90_000});
    await page.waitForFunction(() => document.pointerLockElement && globalThis.honeymoon?.stats().playable);
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
    const render = await page.evaluate(() => {
      const gl = document.querySelector('canvas').getContext('webgl2');
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    });
    await page.evaluate(({yaw,pitch}) => honeymoon.look(yaw,pitch),{yaw:sample.yaw ?? 0,pitch:sample.pitch ?? 0});
    // The walk and flight should exercise loading while playing. At the most
    // distant setting, hundreds of background meshes may still be queued.
    await page.waitForFunction(() => {
      const {streaming, residentChunks} = honeymoon.stats();
      return streaming && residentChunks >= 40;
    }, undefined, {timeout:35_000,polling:250});
    const initial = await page.evaluate(() => honeymoon.stats());
    const before = await memory(cdp, tab);
    const serverBefore = process.memoryUsage();
    await page.evaluate(() => {
      const values = [];
      let previous = performance.now();
      const track = current => {
        values.push(current - previous);
        previous = current;
        window.cityBenchmarkFrame = requestAnimationFrame(track);
      };
      window.cityBenchmarkValues = values;
      window.cityBenchmarkFrame = requestAnimationFrame(track);
    });
    const start = performance.now();
    const traveling = (async () => {
      await page.keyboard.down('KeyW');
      try { await page.waitForTimeout(sample.travel * 1000); }
      finally { await page.keyboard.up('KeyW'); }
      for (let turn = 0; turn < 10; turn++) {
        const yaw = (sample.yaw ?? 0) + (turn % 2 ? .73 : -.73);
        await page.evaluate(yaw => honeymoon.look(yaw,-.09),yaw);
        await page.waitForTimeout(160);
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
    const intervals = await page.evaluate(() => {
      cancelAnimationFrame(window.cityBenchmarkFrame);
      return window.cityBenchmarkValues.slice(1).sort((a,b) => a-b);
    });
    const duration = (performance.now() - start) / 1000;
    const after = await memory(cdp, tab);
    const serverAfter = process.memoryUsage();
    const final = await page.evaluate(() => honeymoon.stats());
    const traveled = Math.hypot(final.position.x - initial.position.x, final.position.z - initial.position.z);
    assert.ok(intervals.length > 100, `${sample.id}, only ${intervals.length} frames`);
    assert.ok(traveled > (sample.walk ? 4 : 18), `${sample.id} traveled ${round(traveled)} blocks from ${JSON.stringify(initial.position)} to ${JSON.stringify(final.position)}`);
    assert.equal(final.movementSync.errors - initial.movementSync.errors, 0, sample.id);
    await page.screenshot({path:join(output,`${sample.id}-${height}-${distance}.png`)});
    return {place:sample.id, resolution:`${width}×${height}`, distance, render,
      startupMs:round(initial.playable), seconds:round(duration), from:initial.position, to:final.position,
      chunksFetched:final.chunksLoaded - initial.chunksLoaded, residentChunks:final.residentChunks,
      triangles:final.triangles, drawCalls:final.calls, meshBufferMiB:mib(final.preciseBytes),
      frames:{count:intervals.length, meanFps:round(1000 * intervals.length / intervals.reduce((a,b) => a+b,0)),
        p50ms:round(percentile(intervals,.50)),p95ms:round(percentile(intervals,.95)),p99ms:round(percentile(intervals,.99)),
        maxMs:round(intervals.at(-1)), over50ms:intervals.filter(ms => ms > 50).length},
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
  for (const [width,height,distance,routes] of [
    [1280,720,4,[samples[0],samples[1]]],
    [1280,720,8,samples],
    [1920,1080,8,[samples[1],samples[2]]],
  ]) for (const sample of routes) {
    const test = await measure(browser,cdp,sample,width,height,distance);
    report.cases.push(test);
    await writeFile(join(output,'benchmark.json'),JSON.stringify(report,null,2)+'\n');
    console.log(JSON.stringify(test));
  }
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
