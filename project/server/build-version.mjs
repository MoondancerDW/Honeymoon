import {readFileSync, renameSync, unlinkSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const buildMarker = /(<meta name="honeymoon-build" content=")([1-9]\d*)(">)/;

export function readBuildNumber(project = projectRoot) {
  let html;
  try {
    html = readFileSync(join(project, 'client', 'index.html'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const build = Number(buildMarker.exec(html)?.[2]);
  return Number.isSafeInteger(build) && build > 0 ? build : null;
}

function bumpBuildNumber(project) {
  const file = join(project, 'client', 'index.html');
  const html = readFileSync(file, 'utf8');
  const current = Number(buildMarker.exec(html)?.[2]);
  if (!Number.isSafeInteger(current) || current >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Missing or invalid Lilium Moonlight build number.');
  }
  const next = current + 1;
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, html.replace(buildMarker, (_, start, number, end) => start + next + end), {flag:'wx'});
    renameSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return next;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log('Lilium Moonlight build ' + bumpBuildNumber(process.argv[2] ? resolve(process.argv[2]) : projectRoot));
}
