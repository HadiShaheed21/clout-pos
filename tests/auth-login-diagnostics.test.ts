import * as assert from 'node:assert/strict';
import { getSafeLoginFailureLog } from '../main/routes/auth';

function run(): void {
  const error = Object.assign(new Error('password=not-for-logs'), {
    code: 'SQLITE_READONLY',
    name: 'SqliteError',
  });
  const diagnostic = getSafeLoginFailureLog('jwt-secret', error);

  assert.deepEqual(diagnostic, {
    stage: 'jwt-secret',
    errorName: 'SqliteError',
    errorCode: 'SQLITE_READONLY',
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /password|not-for-logs/i);

  const nodeDiagnostic = getSafeLoginFailureLog('token-signing', {
    name: 'TypeError',
    code: 'ERR_INVALID_ARG_VALUE',
  });
  assert.deepEqual(nodeDiagnostic, {
    stage: 'token-signing',
    errorName: 'TypeError',
    errorCode: 'ERR_INVALID_ARG_VALUE',
  });

  const unknown = getSafeLoginFailureLog('user-lookup', {
    name: 'unsafe value with spaces',
    code: 'ERR_CLIENT_PASSWORD_SECRET',
  });
  assert.deepEqual(unknown, {
    stage: 'user-lookup',
    errorName: 'UnknownError',
    errorCode: 'unavailable',
  });

  console.log('✅ Login diagnostics redact sensitive error content');
}

run();
