import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const volumePath = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-railway-volume-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: true,
        getPath: () => volumePath,
        getVersion: () => 'test',
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const { closeDatabase, createBackup, getDatabase, getDbPath, initDatabase } = require('../main/db');
const { assertPersistentStorageAvailable } = require('../main/persistent-storage');

async function run(): Promise<void> {
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    dbPath: process.env.FLO_DB_PATH,
    volumePath: process.env.RAILWAY_VOLUME_MOUNT_PATH,
    requirePersistentStorage: process.env.FLO_REQUIRE_PERSISTENT_STORAGE,
  };

  try {
    process.env.NODE_ENV = 'production';
    delete process.env.FLO_DB_PATH;
    process.env.RAILWAY_VOLUME_MOUNT_PATH = volumePath;
    process.env.FLO_REQUIRE_PERSISTENT_STORAGE = 'true';

    const databasePath = path.join(volumePath, 'flo.db');
    const backupPath = path.join(volumePath, 'backups');
    assert.equal(getDbPath(), databasePath, 'Railway volume uses /data/flo.db');
    assert.doesNotThrow(
      () => assertPersistentStorageAvailable(),
      'an existing writable Railway volume is accepted before SQLite starts',
    );
    const missingVolumePath = path.join(volumePath, 'missing-volume');
    assert.throws(
      () => assertPersistentStorageAvailable({
        NODE_ENV: 'production',
        FLO_DB_PATH: path.join(missingVolumePath, 'flo.db'),
        FLO_REQUIRE_PERSISTENT_STORAGE: 'true',
      }),
      /Persistent database storage is unavailable/,
      'a missing Railway volume fails before SQLite can create an ephemeral replacement',
    );
    assert.equal(fs.existsSync(missingVolumePath), false, 'a missing Railway mount root is not silently created');

    initDatabase();
    getDatabase().prepare("INSERT INTO settings (key, value, updated_at) VALUES ('railway_test', 'persisted', ?)")
      .run(new Date().toISOString());
    assert.ok(fs.existsSync(databasePath), 'database is created on the mounted volume');

    const backup = await createBackup();
    assert.equal(path.dirname(backup.path), backupPath, 'backups are stored beside the Railway database');
    assert.ok(fs.existsSync(backup.path), 'backup file exists on the mounted volume');

    closeDatabase();
    initDatabase();
    const persisted = getDatabase().prepare("SELECT value FROM settings WHERE key = 'railway_test'").get() as { value: string } | undefined;
    assert.equal(persisted?.value, 'persisted', 'database records survive a process restart on the same volume');
    console.log('✅ Railway SQLite persistent-volume tests passed');
  } finally {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.dbPath === undefined) delete process.env.FLO_DB_PATH; else process.env.FLO_DB_PATH = previous.dbPath;
    if (previous.volumePath === undefined) delete process.env.RAILWAY_VOLUME_MOUNT_PATH; else process.env.RAILWAY_VOLUME_MOUNT_PATH = previous.volumePath;
    if (previous.requirePersistentStorage === undefined) delete process.env.FLO_REQUIRE_PERSISTENT_STORAGE; else process.env.FLO_REQUIRE_PERSISTENT_STORAGE = previous.requirePersistentStorage;
    fs.rmSync(volumePath, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
