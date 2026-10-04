import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-host-owner-recovery-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-for-host-owner-recovery';
process.env.FLO_OWNER_RECOVERY_TOKEN = 'test-host-owner-recovery-token-32-chars';

const bcrypt = require('bcryptjs');
const express = require('express');
const request = require('supertest');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { authRoutes } = require('../main/routes/auth');

async function run(): Promise<void> {
  initDatabase();
  const db = getDatabase();
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
    VALUES ('owner-recovery-1', 'Owner', 'owner@example.com', ?, 'owner', 1, ?, ?)
  `).run(bcrypt.hashSync('OriginalPass123', 10), now(), now());

  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);

  const unchanged = await request(app).post('/api/auth/recovery/owner-reset').send({
    email: 'owner@example.com',
    new_password: 'ReplacementPass123',
    recovery_token: 'wrong-token',
  });
  assert.equal(unchanged.status, 403, 'invalid recovery token is rejected');
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count, 1, 'rejected recovery never creates or removes users');

  const reset = await request(app).post('/api/auth/recovery/owner-reset').send({
    email: 'Owner@Example.com',
    new_password: 'ReplacementPass123',
    recovery_token: process.env.FLO_OWNER_RECOVERY_TOKEN,
  });
  assert.equal(reset.status, 200, 'valid host-local one-time recovery succeeds');
  assert.doesNotMatch(JSON.stringify(reset.body), /ReplacementPass123|test-host-owner-recovery-token/i, 'response never includes credentials');

  const oldLogin = await request(app).post('/api/auth/login').send({
    email: 'owner@example.com', password: 'OriginalPass123',
  });
  assert.equal(oldLogin.status, 401, 'old password is invalidated');
  const newLogin = await request(app).post('/api/auth/login').send({
    email: 'owner@example.com', password: 'ReplacementPass123',
  });
  assert.equal(newLogin.status, 200, 'new password can log in normally');

  const reused = await request(app).post('/api/auth/recovery/owner-reset').send({
    email: 'owner@example.com',
    new_password: 'AnotherPass123',
    recovery_token: process.env.FLO_OWNER_RECOVERY_TOKEN,
  });
  assert.equal(reused.status, 410, 'recovery is permanently disabled after successful use');
  const unchangedLogin = await request(app).post('/api/auth/login').send({
    email: 'owner@example.com', password: 'ReplacementPass123',
  });
  assert.equal(unchangedLogin.status, 200, 'reused recovery cannot change the owner password');

  console.log('✅ One-time host owner recovery tests passed');
}

run()
  .then(() => closeDatabase())
  .catch((error) => {
    try { closeDatabase(); } catch { /* database may not have initialized */ }
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  });
