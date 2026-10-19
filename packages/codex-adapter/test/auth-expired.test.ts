/** Adapter-internal: an auth error from the run path makes AuthState `expired` until a sign-in completes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthService } from '../src/auth-service.js';
import { AppServerRuntime } from '../src/runtime.js';
import { concat, fakeFactory } from './support/fake-app-server.js';
import { fakeBinary, memoryLogger, recordAuth, until } from './support/harness.js';
import { ManualScheduler } from './support/manual-scheduler.js';

const SIGNED_IN = '<< {"id":"$","result":{"account":{"type":"chatgpt","email":"person@example.com","planType":"plus"},"requiresOpenaiAuth":true}}';
const READ = '>> {"method":"account/read","params":{"refreshToken":false}}';

test('markExpired → expired even though account/read still says signed in; a completed sign-in clears it', async () => {
  const bin = fakeBinary();
  const fakes = fakeFactory([
    concat(
      '>> {"method":"initialize"}',
      '<< {"id":"$","result":{"userAgent":"x","codexHome":"/r","platformFamily":"unix","platformOs":"linux"}}',
      '>> {"method":"initialized"}',
      READ,
      SIGNED_IN,
      '## wait unauthorized',
      READ,
      SIGNED_IN,
      '## wait relogin',
      '<< {"method":"account/login/completed","params":{"loginId":null,"success":true,"error":null,"onboardingEntrypoint":null}}',
      READ,
      SIGNED_IN,
    ),
  ]);
  const runtime = new AppServerRuntime({
    binaryPath: bin.path,
    expectedSha256: bin.sha256,
    codexHome: `${bin.dir}/codex-home`,
    userHome: `${bin.dir}/home`,
    clientVersion: 't',
    parentEnv: {},
    transportFactory: fakes.factory,
    scheduler: new ManualScheduler(),
  });
  const auth = new AuthService(runtime, { logger: memoryLogger(), openExternal: () => assert.fail('no login here') });
  const seen = recordAuth(auth);
  await runtime.start();
  await until(() => seen.at(-1)?.status === 'signed_in', 'signed_in');
  const f = fakes.fakes[0]!;
  await f.reached('unauthorized');
  f.release('unauthorized');
  auth.markExpired();
  await until(() => seen.at(-1)?.status === 'expired', 'expired');
  assert.equal(seen.at(-1)!.accountLabel, null);
  f.release('relogin');
  await f.done();
  await until(() => seen.at(-1)?.status === 'signed_in', 'signed_in again');
  assert.deepEqual(fakes.problems(), []);
});
