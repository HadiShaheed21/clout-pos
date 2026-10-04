import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-web-sqlite-backup-'));
const mockApp = {
  isPackaged: true,
  getPath: () => testDir,
  getVersion: () => 'test',
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

const express = require('express');
const request = require('supertest');
const { initDatabase, closeDatabase } = require('../main/db');
const { databaseRoutes } = require('../main/routes/database');

async function run(): Promise<void> {
  console.log('Testing headless web SQLite snapshot download...');
  try {
    initDatabase();
    const app = express();
    app.use(express.json());
    app.use((_req: any, _res: any, next: () => void) => {
      _req.user = { id: 'owner', role: 'owner' };
      next();
    });
    app.use('/api/db', databaseRoutes);

    const response = await request(app)
      .get('/api/db/download')
      .buffer(true)
      .parse((res: any, callback: (error: Error | null, body: Buffer) => void) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    assert.equal(response.status, 200, 'authenticated owner can download a database snapshot without Electron Master PIN storage');
    assert.match(String(response.headers['content-disposition']), /flo-database-.*\.db/, 'response is an attachment with a SQLite filename');
    assert.equal(response.body.subarray(0, 16).toString('utf8'), 'SQLite format 3\0', 'download is a SQLite database file');
    console.log('✅ Headless web SQLite snapshot download passed');
  } finally {
    try { closeDatabase(); } catch { }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  try { closeDatabase(); } catch { }
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
