import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {copyFile,lstat,mkdir,mkdtemp,readFile,readdir,realpath,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {pathToFileURL} from 'node:url';

const databaseFile = 'honeymoon.sqlite';
const ownerKeyFile = 'npc-admin.key';
const requiredFiles = [databaseFile,ownerKeyFile];
const historyDirectories = ['backups','chat-logs','load-logs'];
const manifestFile = 'snapshot.json';

function missingOnly(error) {
  if (error.code !== 'ENOENT') throw error;
}

async function checkPath(path, kind) {
  const stat = await lstat(path);
  if (!(kind === 'directory' ? stat.isDirectory() : stat.isFile())) {
    throw new Error(`Expected a regular ${kind}: ${path}`);
  }
}

async function makeNewDirectory(destination, build) {
  const existing = await lstat(destination).catch(missingOnly);
  if (existing) throw new Error(`Destination already exists: ${destination}`);
  const parent = await realpath(dirname(destination));
  const staging = await mkdtemp(join(parent,'.hnm-transfer-'));
  try {
    const result = await build(staging);
    if (await lstat(destination).catch(missingOnly)) throw new Error(`Destination already exists: ${destination}`);
    await rename(staging,destination);
    return result;
  } catch (error) {
    const resolved = await realpath(staging);
    if (dirname(resolved) === parent && relative(parent,resolved).startsWith('.hnm-transfer-')) {
      await rm(resolved,{recursive:true,force:true});
    }
    throw error;
  }
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function verifyDatabase(path, worldHash, standalone = false) {
  const db = new DatabaseSync(path,{readOnly:!standalone});
  try {
    if (standalone) db.exec('PRAGMA journal_mode=DELETE');
    if (db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') {
      throw new Error('SQLite integrity check failed');
    }
    const hash = db.prepare("SELECT value FROM metadata WHERE key='base_hash'").get()?.value;
    if (hash !== worldHash) throw new Error('This save uses a different generated world. Install the matching map first.');
  } finally {
    db.close();
  }
}

function historyFile(name) {
  return /^[^/\\:<>{}|?*"\x00-\x1f]+\.(sqlite|log|jsonl)$/i.test(name);
}

async function exportState(state, snapshot, worldHash, backupState) {
  await checkPath(state,'directory');
  for (const name of requiredFiles) await checkPath(join(state,name),'file');
  return makeNewDirectory(snapshot,async destination => {
    await backupState(join(state,databaseFile),join(destination,databaseFile));
    verifyDatabase(join(destination,databaseFile),worldHash,true);
    await copyFile(join(state,ownerKeyFile),join(destination,ownerKeyFile));
    const names = [...requiredFiles];
    for (const directory of historyDirectories) {
      const folder = join(state,directory);
      if (!await lstat(folder).catch(missingOnly)) continue;
      await checkPath(folder,'directory');
      await mkdir(join(destination,directory));
      for (const name of (await readdir(folder)).filter(historyFile).sort()) {
        const file = `${directory}/${name}`;
        const from = join(state,file), to = join(destination,file);
        await checkPath(from,'file');
        if (name.toLowerCase().endsWith('.sqlite')) await backupState(from,to);
        else await copyFile(from,to);
        names.push(file);
      }
    }
    const files = {};
    for (const name of names) files[name] = await digest(join(destination,name));
    await writeFile(join(destination,manifestFile),JSON.stringify({version:1,createdAt:new Date().toISOString(),worldHash,files},null,2)+'\n');
    return names.length;
  });
}

async function importState(state, snapshot, worldHash) {
  await checkPath(snapshot,'directory');
  await checkPath(join(snapshot,manifestFile),'file');
  const manifest = JSON.parse(await readFile(join(snapshot,manifestFile),'utf8'));
  if (manifest?.version !== 1 || manifest.worldHash !== worldHash || !manifest.files ||
      requiredFiles.some(name => !Object.hasOwn(manifest.files,name))) {
    throw new Error('Snapshot is incomplete or uses a different generated world');
  }
  return makeNewDirectory(state,async destination => {
    const folders = new Set();
    const entries = Object.entries(manifest.files);
    for (const [name,hash] of entries) {
      if (!requiredFiles.includes(name)) {
        const [folder,file,extra] = name.split('/');
        if (!historyDirectories.includes(folder) || !file || extra !== undefined || !historyFile(file)) {
          throw new Error('Unexpected file in the snapshot manifest');
        }
        if (!folders.has(folder)) {
          await checkPath(join(snapshot,folder),'directory');
          await mkdir(join(destination,folder));
          folders.add(folder);
        }
      }
      const from = join(snapshot,name), to = join(destination,name);
      await checkPath(from,'file');
      await copyFile(from,to);
      if (await digest(to) !== hash) throw new Error(`Snapshot file failed verification: ${name}`);
    }
    verifyDatabase(join(destination,databaseFile),worldHash);
    return entries.length;
  });
}

const [operation,installedPath,snapshotPath,...extra] = process.argv.slice(2);
try {
  if (!['export','import'].includes(operation) || !installedPath || !snapshotPath || extra.length) {
    throw new Error('Usage: node Transfer-Honeymoon.mjs <export|import> <installed-root> <snapshot-directory>');
  }
  const installed = await realpath(installedPath);
  const snapshot = resolve(snapshotPath);
  const load = path => import(pathToFileURL(join(installed,path)).href);
  const {acquireInstance} = await load('single-instance.mjs');
  const lease = await acquireInstance(installed);
  if (!lease.primary) throw new Error('Close the Honeymoon server on this computer before transferring its save');
  try {
    const {loadBase} = await load('server/base.mjs');
    const worldHash = loadBase(join(installed,'generated','world')).hash;
    const state = join(installed,'state');
    const {backupState} = await load('server/backup.mjs');
    const count = operation === 'export'
      ? await exportState(state,snapshot,worldHash,backupState)
      : await importState(state,snapshot,worldHash);
    console.log(`${operation}: verified ${count} state files`);
  } finally {
    await lease.close();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
