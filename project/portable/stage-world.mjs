import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {displayEntity, displayObject} from '../server/base.mjs';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw new Error('Usage: node portable/stage-world.mjs SOURCE_WORLD NEW_OUTPUT_WORLD');
const source = resolve(sourceArg);
const output = resolve(outputArg);
const manifest = JSON.parse(readFileSync(join(source,'world.json'),'utf8'));
mkdirSync(output);
mkdirSync(join(output,'chunks'));
for (const [x,z] of [...manifest.chunks,...(manifest.visualChunks ?? [])]) {
  const name = `${x}.${z}.json`;
  const chunk = JSON.parse(readFileSync(join(source,'chunks',name),'utf8'));
  chunk.objects = chunk.objects.map(displayObject);
  chunk.entities = chunk.entities.filter(({type}) => type === 'Painting' || type === 'ItemFrame').map(displayEntity);
  const data = JSON.stringify(chunk) + '\n';
  if (manifest.chunkHash?.[name]) manifest.chunkHash[name] = createHash('sha256').update(data).digest('hex');
  writeFileSync(join(output,'chunks',name),data);
}
for (const {file} of manifest.terrain ?? []) {
  writeFileSync(join(output,file),readFileSync(join(source,file)));
}
writeFileSync(join(output,'world.json'),JSON.stringify(manifest) + '\n');
console.log(`Staged ${manifest.chunks.length} playable chunks`);
