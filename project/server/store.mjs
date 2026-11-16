import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { publicMicroPart } from '../world/microblocks.mjs';

const SCHEMA_VERSION = 10;
const chatHistoryLimit = 100;
const MiB = 1024 * 1024;
export const receiptLimits = Object.freeze({age:15*60_000,entryBytes:256*1024,
  playerRows:1024,playerBytes:8*MiB,totalRows:8192,totalBytes:64*MiB});
const compactReceiptOutput=JSON.stringify({error:'action_result_expired'});

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

function migrateReceipts(db) {
  if (db.prepare('PRAGMA table_info(receipts)').all().some(column=>column.name==='created_at')) return;
  db.exec(`
    ALTER TABLE receipts RENAME TO receipts_legacy;
    CREATE TABLE receipts (
      seq INTEGER PRIMARY KEY, player TEXT NOT NULL REFERENCES players(id), id TEXT NOT NULL,
      input TEXT NOT NULL, status INTEGER NOT NULL, output TEXT NOT NULL, created_at INTEGER NOT NULL,
      byte_size INTEGER AS (length(CAST(id AS BLOB))+length(CAST(input AS BLOB))+length(CAST(output AS BLOB))) STORED,
      UNIQUE (player,id)
    ) STRICT;
    CREATE INDEX receipts_by_age ON receipts(created_at);
    CREATE INDEX receipts_by_player_order ON receipts(player,seq);
    CREATE TABLE receipt_usage (owner TEXT PRIMARY KEY, entries INTEGER NOT NULL, bytes INTEGER NOT NULL) STRICT;
    CREATE TRIGGER receipt_on_insert AFTER INSERT ON receipts BEGIN
      INSERT INTO receipt_usage VALUES ('',1,new.byte_size),(new.player,1,new.byte_size)
      ON CONFLICT(owner) DO UPDATE SET entries=entries+1, bytes=bytes+excluded.bytes;
    END;
    CREATE TRIGGER receipt_on_delete AFTER DELETE ON receipts BEGIN
      UPDATE receipt_usage SET entries=entries-1, bytes=bytes-old.byte_size WHERE owner IN ('',old.player);
      DELETE FROM receipt_usage WHERE owner=old.player AND entries=0;
    END;
    CREATE TRIGGER receipt_on_update AFTER UPDATE OF input,output ON receipts BEGIN
      UPDATE receipt_usage SET bytes=bytes+new.byte_size-old.byte_size WHERE owner IN ('',old.player);
    END;
  `);
  // Legacy saves have no timestamps. Only inspect the newest bounded slice and keep its replay order.
  db.prepare(`WITH measured AS MATERIALIZED (
      SELECT rowid AS old_seq, player, length(CAST(id AS BLOB))+length(CAST(input AS BLOB)) AS prefix,
        length(CAST(output AS BLOB)) AS output_bytes FROM receipts_legacy ORDER BY rowid DESC LIMIT ?1
    ), recent AS (
      SELECT old_seq,player,prefix+output_bytes>?2 AS compact,
        prefix+CASE WHEN prefix+output_bytes>?2 THEN length(CAST(?3 AS BLOB)) ELSE output_bytes END AS bytes
        FROM measured
    ), per_player AS (
      SELECT *, ROW_NUMBER() OVER newest AS position, SUM(bytes) OVER newest AS player_bytes
        FROM recent WHERE bytes<=?2 WINDOW newest AS (PARTITION BY player ORDER BY old_seq DESC)
    ), retained AS (
      SELECT old_seq,compact,SUM(bytes) OVER (ORDER BY old_seq DESC) AS total_bytes
        FROM per_player WHERE position<=?4 AND player_bytes<=?5
    )
    INSERT INTO receipts(player,id,input,status,output,created_at)
      SELECT legacy.player,legacy.id,legacy.input,CASE WHEN compact THEN 409 ELSE legacy.status END,
        CASE WHEN compact THEN ?3 ELSE legacy.output END,?6
      FROM retained JOIN receipts_legacy legacy ON legacy.rowid=retained.old_seq
      WHERE retained.total_bytes<=?7 ORDER BY retained.old_seq`)
    .run(receiptLimits.totalRows,receiptLimits.entryBytes,compactReceiptOutput,receiptLimits.playerRows,receiptLimits.playerBytes,
      Date.now(),receiptLimits.totalBytes);
  db.exec('DROP TABLE receipts_legacy');
}

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
    if (version < 8) db.exec("ALTER TABLE edits ADD COLUMN fluid TEXT CHECK (fluid IN ('water','lava','dry'));");
    if (version < 9) {
      const columns=new Set(db.prepare('PRAGMA table_info(players)').all().map(column=>column.name));
      if (!columns.has('profile_name')) db.exec('ALTER TABLE players ADD COLUMN profile_name TEXT;');
      if (!columns.has('access_role'))
        db.exec("ALTER TABLE players ADD COLUMN access_role TEXT NOT NULL DEFAULT 'player' CHECK (access_role IN ('player','admin'));");
      db.exec(`
      CREATE TABLE IF NOT EXISTS access_devices (
        id TEXT PRIMARY KEY,
        player TEXT NOT NULL REFERENCES players(id),
        token_hash TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        revoked_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS access_devices_by_player ON access_devices(player,created_at);
      CREATE TABLE IF NOT EXISTS access_invites (
        id TEXT PRIMARY KEY,
        code_hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('player','admin','device')),
        player TEXT REFERENCES players(id),
        issuer TEXT NOT NULL REFERENCES players(id),
        label TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        used_at INTEGER,
        revoked_at INTEGER
      ) STRICT;
      `);
    }
    if (version < 10) migrateReceipts(db);
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
  const readReceipt = statement('SELECT input,status,output FROM receipts WHERE player=? AND id=? AND created_at>?');
  const writeReceipt = statement('INSERT INTO receipts(player,id,input,status,output,created_at) VALUES (?,?,?,?,?,?)');
  const pruneReceipts = statement('DELETE FROM receipts WHERE created_at<=?');
  const expireReceipt = statement('DELETE FROM receipts WHERE player=? AND id=? AND created_at<=?');
  const receiptUsage = statement('SELECT entries,bytes FROM receipt_usage WHERE owner=?');
  const evictPlayerReceipt = statement(`DELETE FROM receipts WHERE seq=(SELECT seq FROM receipts
    WHERE player=? ORDER BY seq LIMIT 1) RETURNING byte_size AS bytes`);
  const evictTotalReceipt = statement(`DELETE FROM receipts WHERE seq=(SELECT seq FROM receipts ORDER BY seq LIMIT 1)
    RETURNING byte_size AS bytes`);
  function reserveReceiptSpace(owner,bytes,maxRows,maxBytes,evict,parameters) {
    let {entries=0,bytes:used=0}=receiptUsage.get(owner)??{};
    while (entries>=maxRows || used+bytes>maxBytes) {
      const removed=evict.get(...parameters);
      if (!removed) throw new Error('Receipt usage does not match the replay cache.');
      entries--;
      used-=removed.bytes;
    }
  }
  const readState = statement('SELECT version,value FROM module_state WHERE module=? AND owner=? AND key=?');
  const writeState = statement(`INSERT INTO module_state VALUES (?,?,?,?,?) ON CONFLICT(module,owner,key)
    DO UPDATE SET version=excluded.version,value=excluded.value`);
  const readEdit = statement('SELECT cell,object,revision,micro_parts,voxels,fluid FROM edits WHERE x=? AND y=? AND z=? AND quarantined=0');
  const readMicroParts = statement('SELECT micro_parts FROM edits WHERE x=? AND y=? AND z=? AND quarantined=0');
  const readEditOwner = statement('SELECT placed_by FROM edits WHERE x=? AND y=? AND z=? AND cell IS NOT NULL AND quarantined=0');
  const listEdits = statement('SELECT x,y,z,cell,object,revision,micro_parts,voxels,fluid FROM edits WHERE quarantined=0 ORDER BY x,y,z');
  const writeEdit = statement(`INSERT INTO edits(x,y,z,cell,object,revision,original,quarantined,placed_by,micro_parts,voxels,fluid)
    VALUES (?,?,?,?,?,?,?,0,?,?,?,?) ON CONFLICT(x,y,z) DO UPDATE SET cell=excluded.cell,
    object=excluded.object,revision=excluded.revision,quarantined=0,micro_parts=excluded.micro_parts,voxels=excluded.voxels,fluid=excluded.fluid,
    placed_by=CASE WHEN excluded.placed_by IS NOT NULL THEN excluded.placed_by
      WHEN excluded.micro_parts IS NOT NULL OR NOT ? THEN NULL
      WHEN edits.quarantined=0 THEN edits.placed_by END`);
  const allEdits = statement('SELECT x,y,z,cell,original,placed_by,micro_parts IS NOT NULL AS is_multipart,voxels,fluid FROM edits ORDER BY x,y,z');
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
    const { micro_parts: raw, voxels, fluid, ...edit } = row;
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
      ...(decoded && {parts: decoded.parts}), ...(sculpture && {voxels: sculpture}),
      ...(fluid && fluid !== 'dry' && {fluid}) };
  }

  return {
    db,
    atomic: run => transaction(db, run),
    close: () => db.close(),
    baseHash: () => readMeta.get('base_hash')?.value,
    worldRevision,
    nextRevision() {
      const revision = worldRevision() + 1;
      writeMeta.run('world_revision', String(revision));
      return revision;
    },
    createPlayer(id = randomUUID()) {
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
    getReceipt(player, id, at = Date.now()) {
      const stored = readReceipt.get(player, id,Math.trunc(at)-receiptLimits.age);
      return stored && { ...stored, output: JSON.parse(stored.output) };
    },
    pruneReceipts(at=Date.now()) {
      return pruneReceipts.run(Math.trunc(at)-receiptLimits.age).changes;
    },
    putReceipt(player, id, input, status, output, at = Date.now()) {
      const time=Math.trunc(at);
      let encoded=JSON.stringify(output);
      const prefixBytes=Buffer.byteLength(id)+Buffer.byteLength(input);
      let size=prefixBytes+Buffer.byteLength(encoded);
      if (size>receiptLimits.entryBytes) {
        encoded=compactReceiptOutput;
        status=409;
        size=prefixBytes+Buffer.byteLength(encoded);
      }
      // HTTP limits the request well below this bound. Do not quietly drop an idempotency record.
      if (size>receiptLimits.entryBytes) throw new Error('Action input exceeds the replay cache limit.');
      expireReceipt.run(player,id,time-receiptLimits.age);
      reserveReceiptSpace(player,size,receiptLimits.playerRows,receiptLimits.playerBytes,evictPlayerReceipt,[player]);
      reserveReceiptSpace('',size,receiptLimits.totalRows,receiptLimits.totalBytes,evictTotalReceipt,[]);
      writeReceipt.run(player,id,input,status,encoded,time);
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
    writeEdit({ x, y, z, cell, object, revision, voxels, fluid }, original, placedBy = null, parts = null, inheritOwner = true) {
      writeEdit.run(x, y, z, cell, object ? JSON.stringify(object) : null, revision, original, placedBy,
        parts === null ? null : JSON.stringify(parts), voxels ? JSON.stringify(voxels) : null, fluid ?? null, Number(inheritOwner));
    },
    rebase(base, reserved, originalAt) {
      return transaction(db, () => {
        const previousHash = readMeta.get('base_hash')?.value;
        if (previousHash === base.hash) return listConflicts.all(base.hash);
        for (const { x, y, z, cell, original, placed_by: owner, is_multipart: isMultipart, voxels, fluid } of allEdits.all()) {
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
          } else if (current !== original && (isMultipart || fluid || owner && base.getCell(x, y, z).key !== 'air')) {
            reason = 'original_cell_changed';
            quarantined = 1;
          } else if (original !== null && current !== original) {
            reason = 'original_cell_changed';
          }
          if (reason) insertConflict.run(base.hash, x, y, z, original, current, cell, reason);
          updateOriginal.run((isMultipart || fluid) && quarantined ? original : current, quarantined, x, y, z);
        }
        if (previousHash) writeMeta.run('world_revision', String(worldRevision() + 1));
        writeMeta.run('base_hash', base.hash);
        return listConflicts.all(base.hash);
      });
    },
  };
}
