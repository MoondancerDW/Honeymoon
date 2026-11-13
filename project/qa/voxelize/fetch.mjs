import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const version = '3.0.0';
const work = new URL('../../work/voxelize-spike/', import.meta.url);
const packages = {
  core: 'xIiJtMCsOyCvt3LBsgm41sAPkEm2LNfAP+ah9NvQ17IJOVpAmMh/e7IG4geWkShUq32VoDvpE2NP2iEgL5Xm2A==',
  'wasm-mesher': 'jNH4LRIQyzkwjFXBgZDtbRDTX1jCbo6SI9KEmLHXi63joaT6eg6RT0VmLblI5BOFemNpHgPBzIGGF4KzEnoOHA==',
  aabb: 'fBo8Tubi9eaSKjD7b3/VIJgYiTUUj7nzillZiLc6fZ62Lgr5W7UDY1WWMSfjwVaWwvPOKA327m0m8t2pa6PdlA==',
  'physics-engine': 'l/3YK24Qea6n5VDv23+mZkKlXvUWG3e/K+AcBm8KcdFe65gZJhBawzUPHDw10UQcBEJoJvoM+RpvODU1krjoAA==',
  raycast: 'uFcWb8WQvQgSfP5YeP0TmlMDvaOYZ2sffMMLmLMLwOvfSglgQAVnM/gyhhDmI3MnmyTIDuE4bTziMMp4LlU9fw==',
};
const entries = {
  core: ['dist/index.mjs'],
  'wasm-mesher': ['pkg/package.json', 'pkg/voxelize_wasm_mesher.js', 'pkg/voxelize_wasm_mesher_bg.wasm'],
  aabb: ['dist/index.mjs', 'dist/index.js'],
  'physics-engine': ['dist/index.js'],
  raycast: ['dist/index.mjs', 'dist/index.js'],
};

for (const [name, sha512] of Object.entries(packages)) {
  const url = `https://registry.npmjs.org/@voxelize/${name}/-/${name}-${version}.tgz`;
  const bytes = execFileSync('curl', ['--fail', '--silent', '--show-error', '--connect-timeout', '10',
    '--max-time', '30', url], { maxBuffer: 10 * 1024 * 1024 });
  assert.equal(createHash('sha512').update(bytes).digest('base64'), sha512, `Integrity check for ${name}`);
  const directory = new URL(`node_modules/@voxelize/${name}`, work);
  const archive = new URL(`${name}.tgz`, work);
  mkdirSync(directory, { recursive: true });
  writeFileSync(archive, bytes);
  for (const entry of ['package.json', ...entries[name]]) {
    const content = execFileSync('tar', ['-xOzf', fileURLToPath(archive), 'package/' + entry],
      { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
    const destination = new URL(`node_modules/@voxelize/${name}/${entry}`, work);
    mkdirSync(new URL('.', destination), { recursive: true });
    writeFileSync(destination, content);
  }
  console.log(`@voxelize/${name}@${version}`);
}
