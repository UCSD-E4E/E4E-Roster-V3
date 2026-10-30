import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';

test('fake authentication cannot be enabled outside test environments', () => {
  const previous = process.env.NODE_ENV;
  try {
    for (const environment of ['production', 'development', undefined]) {
      if (environment) process.env.NODE_ENV = environment;
      else delete process.env.NODE_ENV;
      assert.throws(() => createApp({ testUserFromRequest: () => undefined }), /Test authentication/);
    }
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('production ignores fake-user headers and has no demo endpoint', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const server = createApp().listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const protectedPage = await fetch(`${url}/orgs/alpha/v2/people`, {
      headers: { 'x-test-user': 'alpha-admin' }, redirect: 'manual',
    });
    assert.equal(protectedPage.status, 302);
    assert.match(protectedPage.headers.get('location')!, /^\/login/);
    assert.equal((await fetch(`${url}/demo`, { redirect: 'manual' })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('production rejects skipped OIDC before any external startup work', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, NODE_ENV: 'production', SKIP_OIDC: 'true', SESSION_SECRET: 'production-boundary-test' },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SKIP_OIDC is not allowed in production/);
  assert.doesNotMatch(result.stdout, /Discovering OIDC|migrations complete|starting LDAP/);
});
