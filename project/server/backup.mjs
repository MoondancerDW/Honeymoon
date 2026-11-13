import { existsSync, mkdirSync, openSync, closeSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));

export async function backupState(source, destination) {
  const original = resolve(source);
  const target = resolve(destination);
  if (!existsSync(original)) throw new Error(`Save file does not exist: ${original}`);
  mkdirSync(dirname(target), { recursive: true });
  const reservation = openSync(target, 'wx');
  closeSync(reservation);
  let database;
  try {
    database = new DatabaseSync(original, { readOnly: true });
    database.exec('PRAGMA busy_timeout=5000');
    return await backup(database, target);
  } catch (error) {
    rmSync(target, { force: true });
    throw error;
  } finally {
    database?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const day = new Date().toISOString().slice(0, 10);
  const source = process.env.HONEYMOON_STATE || join(project, 'state', 'honeymoon.sqlite');
  const destination = process.argv[2] || join(project, 'state', 'backups', `honeymoon-${day}.sqlite`);
  const pages = await backupState(source, destination);
  console.log(`${pages} pages backed up to ${resolve(destination)}`);
}
