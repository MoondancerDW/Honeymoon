import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { publicMicroPart } from '../world/microblocks.mjs';

const SCHEMA_VERSION = 7;
const chatHistoryLimit = 100;

export function transaction(db, run) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const initialSchema = `
  CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  INSERT INTO metadata VALUES ('world_revision', '0');
  CREATE TABLE players (
    id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, clipboard TEXT
  ) STRICT;
  CREATE TABLE edits (
    x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
    cell TEXT, object TEXT, revision INTEGER NOT NULL,
    PRIMARY KEY (x,y,z)
  ) STRICT;
  CREATE TABLE receipts (
    player TEXT NOT NULL REFERENCES players(id), id TEXT NOT NULL,
    input TEXT NOT NULL, status INTEGER NOT NULL, output TEXT NOT NULL,
    PRIMARY KEY (player,id)
  ) STRICT;
  CREATE TABLE module_state (
    module TEXT NOT NULL, owner TEXT NOT NULL, key TEXT NOT NULL,
    version INTEGER NOT NULL, value TEXT NOT NULL,
    PRIMARY KEY (module,owner,key)
  ) STRICT;
  PRAGMA user_version = 1;
`;

function migrate(db) {
  const readVersion = db.prepare('PRAGMA user_version');
  if (readVersion.get().user_version === SCHEMA_VERSION) return;
  transaction(db, () => {
    const version = readVersion.get().user_version;
    if (version > SCHEMA_VERSION) throw new Error(`Save schema ${version} requires a newer Honeymoon server.`);
    if (version === SCHEMA_VERSION) return;
    if (version === 0) db.exec(initialSchema);
    if (version < 2) {
      db.exec(`
        ALTER TABLE edits ADD COLUMN original TEXT;
        ALTER TABLE edits ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE rebase_conflicts (
          base_hash TEXT NOT NULL, x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
          previous_base TEXT, new_base TEXT, edit TEXT, reason TEXT NOT NULL,
          PRIMARY KEY (base_hash,x,y,z)
        ) STRICT;
      `);
    }
    if (version < 3) db.exec(`ALTER TABLE edits ADD COLUMN placed_by TEXT REFERENCES players(id);
      WITH proven AS (
        SELECT edits.x,edits.y,edits.z,MIN(receipts.player) AS owner
        FROM receipts
        JOIN edits ON edits.x=json_extract(receipts.input, '$.x')
          AND edits.y=json_extract(receipts.input, '$.y')
          AND edits.z=json_extract(receipts.input, '$.z')
        WHERE receipts.status=200 AND json_extract(receipts.input, '$.type')='place'
          AND edits.cell IS NOT NULL AND edits.quarantined=0
          AND json_extract(receipts.output, '$.worldRevision')=edits.revision
          AND EXISTS (
            SELECT 1 FROM json_each(receipts.output, '$.changes') AS change
            WHERE json_extract(change.value, '$.x')=edits.x
              AND json_extract(change.value, '$.y')=edits.y
              AND json_extract(change.value, '$.z')=edits.z
              AND json_extract(change.value, '$.revision')=edits.revision
              AND json_extract(change.value, '$.cell')=edits.cell
          )
        GROUP BY edits.x,edits.y,edits.z
        HAVING count(DISTINCT receipts.player)=1
      )
      UPDATE edits SET placed_by=proven.owner FROM proven
        WHERE edits.x=proven.x AND edits.y=proven.y AND edits.z=proven.z;`);
    if (version < 4) db.exec('ALTER TABLE edits ADD COLUMN micro_parts TEXT;');
    if (version < 5) db.exec('ALTER TABLE edits ADD COLUMN voxels TEXT;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS player_profiles (
        player TEXT PRIMARY KEY REFERENCES players(id),
        nickname TEXT, skin_hash TEXT, skin_png BLOB
      ) STRICT;
      CREATE INDEX IF NOT EXISTS profiles_by_skin_hash ON player_profiles(skin_hash) WHERE skin_hash IS NOT NULL;
      CREATE TABLE IF NOT EXISTS chat_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT NOT NULL, recipients TEXT
      ) STRICT;
      PRAGMA user_version = ${SCHEMA_VERSION};
    `);
  });
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function openStore(filename) {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    migrate(db);
  } catch (error) {
    db.close();
    throw error;
  }
  const statement = sql => db.prepare(sql);
  const readMeta = statement('SELECT value FROM metadata WHERE key=?');
  const writeMeta = statement('INSERT INTO metadata VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  const findPlayer = statement('SELECT id FROM players WHERE token_hash=?');
  const addPlayer = statement('INSERT INTO players(id,token_hash) VALUES (?,?)');
  const readProfile = statement('SELECT nickname,skin_hash AS skinHash FROM player_profiles WHERE player=?');
  const writeNickname = statement(`INSERT INTO player_profiles(player,nickname) VALUES (?,?)
    ON CONFLICT(player) DO UPDATE SET nickname=excluded.nickname`);
  const writeSkin = statement(`INSERT INTO player_profiles(player,skin_hash,skin_png) VALUES (?,?,?)
    ON CONFLICT(player) DO UPDATE SET skin_hash=excluded.skin_hash,skin_png=excluded.skin_png`);
  const readSkin = statement('SELECT skin_png AS png FROM player_profiles WHERE skin_hash=? LIMIT 1');
  const readClipboard = statement('SELECT clipboard FROM players WHERE id=?');
  const writeClipboard = statement('UPDATE players SET clipboard=? WHERE id=?');
  const readReceipt = statement('SELECT input,status,output FROM receipts WHERE player=? AND id=?');
  const writeReceipt = statement('INSERT INTO receipts VALUES (?,?,?,?,?)');
  const readState = statement('SELECT version,value FROM module_state WHERE module=? AND owner=? AND key=?');
  const writeState = statement(`INSERT INTO module_state VALUES (?,?,?,?,?) ON CONFLICT(module,owner,key)
    DO UPDATE SET version=excluded.version,value=excluded.value`);
  const readEdit = statement('SELECT cell,object,revision,micro_parts,voxels FROM edits WHERE x=? AND y=? AND z=? AND quarantined=0');
  const readMicroParts = statement('SELECT micro_parts FROM edits WHERE x=? AND y=? AND z=? AND quarantined=0');
  const readEditOwner = statement('SELECT placed_by FROM edits WHERE x=? AND y=? AND z=? AND cell IS NOT NULL AND quarantined=0');
  const listEdits = statement('SELECT x,y,z,cell,object,revision,micro_parts,voxels FROM edits WHERE quarantined=0 ORDER BY x,y,z');
  const writeEdit = statement(`INSERT INTO edits(x,y,z,cell,object,revision,original,quarantined,placed_by,micro_parts,voxels)
    VALUES (?,?,?,?,?,?,?,0,?,?,?) ON CONFLICT(x,y,z) DO UPDATE SET cell=excluded.cell,
    object=excluded.object,revision=excluded.revision,quarantined=0,micro_parts=excluded.micro_parts,voxels=excluded.voxels,
    placed_by=CASE WHEN excluded.placed_by IS NOT NULL THEN excluded.placed_by
      WHEN excluded.micro_parts IS NOT NULL THEN NULL
      WHEN edits.quarantined=0 THEN edits.placed_by END`);
  const allEdits = statement('SELECT x,y,z,cell,original,placed_by,micro_parts IS NOT NULL AS is_multipart,voxels FROM edits ORDER BY x,y,z');
  const updateOriginal = statement('UPDATE edits SET original=?,quarantined=? WHERE x=? AND y=? AND z=?');
  const insertConflict = statement('INSERT OR REPLACE INTO rebase_conflicts VALUES (?,?,?,?,?,?,?,?)');
  const listConflicts = statement('SELECT * FROM rebase_conflicts WHERE base_hash=? ORDER BY x,y,z');

  const writeChat = statement('INSERT INTO chat_entries(message,recipients) VALUES (?,?) RETURNING id');
  const listChat = statement(`SELECT id, message FROM chat_entries
    WHERE recipients IS NULL OR EXISTS (SELECT 1 FROM json_each(recipients) WHERE value=?) ORDER BY id`);
  const trimChat = statement('DELETE FROM chat_entries WHERE id <= (SELECT id FROM chat_entries ORDER BY id DESC LIMIT 1 OFFSET ?)');

  function appendChat(message, recipients = null) {
    const {id} = writeChat.get(JSON.stringify(message), recipients && JSON.stringify(recipients));
    trimChat.run(chatHistoryLimit);
    return {id, ...message};
  }

  const worldRevision = () => Number(readMeta.get('world_revision').value);
  const partsCache = new Map();
  const voxelCache = new Map();
  function readParts(raw) {
    if (raw == null) return null;
    let cached = partsCache.get(raw);
    if (!cached) {
      const owned = JSON.parse(raw);
      const parts = owned.map(publicMicroPart);
      cached = {owned, parts};
      if (partsCache.size >= 512) partsCache.delete(partsCache.keys().next().value);
      partsCache.set(raw, cached);
    }
    return cached;
  }
  function unpackEdit(row) {
    if (!row) return row;
    const { micro_parts: raw, voxels, ...edit } = row;
    const decoded = readParts(raw);
    let sculpture;
    if (voxels !== null) {
      sculpture = voxelCache.get(voxels);
      if (!sculpture) {
        sculpture = JSON.parse(voxels);
        if (voxelCache.size >= 256) voxelCache.delete(voxelCache.keys().next().value);
        voxelCache.set(voxels, sculpture);
      }
    }
    return { ...edit, object: edit.object ? JSON.parse(edit.object) : null,
      ...(decoded && {parts: decoded.parts}), ...(sculpture && {voxels: sculpture}) };
  }

  return {
    db,
    atomic: run => transaction(db, run),
    close: () => db.close(),
    worldRevision,
    nextRevision() {
      const revision = worldRevision() + 1;
      writeMeta.run('world_revision', String(revision));
      return revision;
    },
    createPlayer() {
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      addPlayer.run(id, tokenHash(token));
      return { id, token };
    },
    playerFromToken(token) {
      if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      return findPlayer.get(tokenHash(token))?.id ?? null;
    },
    getProfile(player) {
      return readProfile.get(player);
    },
    updateProfile(player, { nickname, skin }, previousNickname) {
      return transaction(db, () => {
        if (nickname !== undefined) writeNickname.run(player, nickname);
        if (skin !== undefined) writeSkin.run(player, skin?.hash ?? null, skin?.png ?? null);
        if (nickname !== undefined && previousNickname && nickname !== previousNickname) {
          return appendChat({kind:'rename', nickname:previousNickname, newNickname:nickname, channel:'global'});
        }
      });
    },
    chatHistory: player => listChat.all(player).map(({id, message}) => ({id, ...JSON.parse(message)})),
    recordChat: (message, recipients) => transaction(db, () => appendChat(message, recipients)),
    getSkin(hash) {
      return readSkin.get(hash)?.png ?? null;
    },
    getClipboard(player) {
      const stored = readClipboard.get(player).clipboard;
      return stored ? JSON.parse(stored) : null;
    },
    putClipboard(player, value) {
      writeClipboard.run(JSON.stringify(value), player);
    },
    getReceipt(player, id) {
      const stored = readReceipt.get(player, id);
      return stored && { ...stored, output: JSON.parse(stored.output) };
    },
    putReceipt(player, id, input, status, output) {
      writeReceipt.run(player, id, input, status, JSON.stringify(output));
    },
    getState(module, owner, key) {
      const stored = readState.get(module, owner, key);
      return stored && { version: stored.version, value: JSON.parse(stored.value) };
    },
    putState(module, owner, key, version, value) {
      writeState.run(module, owner, key, version, JSON.stringify(value));
    },
    getEdit(x, y, z) {
      return unpackEdit(readEdit.get(x, y, z));
    },
    getEditOwner(x, y, z) {
      return readEditOwner.get(x, y, z)?.placed_by ?? null;
    },
    getMicroParts(x, y, z) {
      return readParts(readMicroParts.get(x, y, z)?.micro_parts)?.owned ?? null;
    },
    edits() {
      return listEdits.all().map(unpackEdit);
    },
    writeEdit({ x, y, z, cell, object, revision, voxels }, original, placedBy = null, parts = null) {
      writeEdit.run(x, y, z, cell, object ? JSON.stringify(object) : null, revision, original, placedBy,
        parts === null ? null : JSON.stringify(parts), voxels ? JSON.stringify(voxels) : null);
    },
    rebase(base, reserved, originalAt) {
      return transaction(db, () => {
        const previousHash = readMeta.get('base_hash')?.value;
        if (previousHash === base.hash) return listConflicts.all(base.hash);
        for (const { x, y, z, cell, original, placed_by: owner, is_multipart: isMultipart, voxels } of allEdits.all()) {
          const current = originalAt(x, y, z);
          let reason;
          let quarantined = 0;
          if (!base.inBounds(x, y, z) || reserved(x, y, z)) {
            reason = 'outside_playable_area';
            quarantined = 1;
          } else if (voxels ? JSON.parse(voxels).materials.some(material => !base.catalog.has(material))
            : !isMultipart && cell !== null && !base.catalog.has(cell)) {
            reason = 'missing_catalog_entry';
            quarantined = 1;
          } else if ((isMultipart && current !== original) || (!isMultipart && owner && base.getCell(x, y, z).key !== 'air')) {
            reason = 'original_cell_changed';
            quarantined = 1;
          } else if (original !== null && current !== original) {
            reason = 'original_cell_changed';
          }
          if (reason) insertConflict.run(base.hash, x, y, z, original, current, cell, reason);
          updateOriginal.run(isMultipart && quarantined ? original : current, quarantined, x, y, z);
        }
        if (previousHash) writeMeta.run('world_revision', String(worldRevision() + 1));
        writeMeta.run('base_hash', base.hash);
        return listConflicts.all(base.hash);
      });
    },
  };
}
