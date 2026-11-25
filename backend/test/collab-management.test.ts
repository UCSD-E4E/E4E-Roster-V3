import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { db, runMigrations } from '../src/services/db';
import { setCollabAdmin } from '../src/services/collab-access';
import { getCollaboratorCatalog } from '../src/services/authentik';
import type { AuthUser } from '../src/types/user';

const flow = '11111111-1111-4111-8111-111111111111';
const brand = '22222222-2222-4222-8222-222222222222';
const invitation = '33333333-3333-4333-8333-333333333333';
function user(username: string, role?: 'project_lead' | 'org_admin', system = false): AuthUser {
  return { id: username, username, name: username, email: `${username}@example.test`, groups: ['collab-admins'], isSystemAdmin: system,
    orgs: role ? [{ orgId: 1, orgSlug: 'test', orgName: 'Test', role }] : [] };
}
const users = new Map([
  ['system', user('system', undefined, true)], ['lead', user('lead', 'project_lead')],
  ['org-admin', user('org-admin', 'org_admin')], ['member', user('member')],
  ['local', { ...user('local'), isLocalAdmin: true }],
]);
const realFetch = globalThis.fetch;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let base: string;
let catalog: Record<string, unknown>;
let providerStatus = 200;
let createPayloads: Record<string, unknown>[] = [];
let providerCalls = 0;
function request(path: string, username = '', body?: Record<string, string>, extraHeaders: Record<string, string> = {}) {
  return realFetch(`${base}${path}`, { redirect: 'manual', ...(body ? { method: 'POST', body: new URLSearchParams(body) } : {}), headers: { Origin: base, 'x-test-user': username, ...extraHeaders } });
}
const valid = { destination: 'fishsense/reef', email: 'Person@Example.org', days: '7' };

before(async () => {
  await runMigrations();
  await db.query('TRUNCATE users, roster_role_grants, audit_log CASCADE');
  await db.query("INSERT INTO users (username) VALUES ('system'), ('lead'), ('org-admin'), ('member')");
  process.env.AUTHENTIK_URL = 'https://auth.example.test';
  process.env.AUTHENTIK_BRAND_ID = brand;
  process.env.AUTHENTIK_API_TOKEN = 'provider-secret-never-render';
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.startsWith('https://auth.example.test/api/v3/'), 'No other upstream requests are allowed');
    providerCalls++;
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer provider-secret-never-render');
    assert.equal(init?.redirect, 'error');
    if (providerStatus !== 200) return new Response('provider-secret-never-render private provider error', { status: providerStatus });
    if (url.endsWith(`/core/brands/${brand}/`)) return Response.json({ attributes: { roster_collaborators: catalog } });
    assert.ok(url.endsWith('/stages/invitation/invitations/'));
    assert.equal(init?.method, 'POST');
    createPayloads.push(JSON.parse(String(init.body)));
    return Response.json({ pk: invitation }, { status: 201 });
  };
  server = createApp({ testUserFromRequest: (req) => users.get(req.header('x-test-user') ?? '') }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  catalog = { flow, flowSlug: 'krg-collaborator-enrollment', tenants: [{ id: 'fishsense', name: 'FishSense', organizations: [{ id: 'reef', name: 'REEF' }], applications: [{ name: 'FishSense web', url: 'https://fishsense.example.test/' }] }] };
  providerStatus = 200; createPayloads = []; providerCalls = 0;
  await db.query('DELETE FROM roster_role_grants');
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await db.end();
});

test('anonymous, member, lead, org admin, system admin, and local admin get 403 without an explicit grant', async () => {
  for (const username of ['', ...users.keys()]) {
    assert.equal((await request('/collab-manage', username)).status, 403, username);
    assert.equal((await request('/collab-manage', username, valid)).status, 403, username);
  }
  // The synthetic OIDC collab-admins group above never grants this permission.
  assert.equal(providerCalls, 0);
});

test('only system administrators grant the role, including to themselves', async () => {
  for (const username of ['lead', 'org-admin', 'member']) {
    assert.equal((await request('/system/v2/collab-admins', username, { intent: 'grant', username })).status, 403);
    await assert.rejects(setCollabAdmin(users.get(username)!, username, true), /System administrator/);
  }
  assert.equal((await request('/system/v2/collab-admins', 'system')).status, 200);
  assert.equal((await request('/system/v2/collab-admins', 'system', { intent: 'grant', username: 'system' })).status, 302);
  assert.equal((await request('/collab-manage', 'system')).status, 200);
  assert.equal((await request('/system/v2/collab-admins', 'system', { intent: 'grant', username: 'missing' })).status, 400);
});

test('grants coexist with project lead and org admin roles, and are revoked immediately', async () => {
  for (const username of ['lead', 'org-admin']) {
    await setCollabAdmin(users.get('system')!, username, true);
    const response = await request('/collab-manage', username);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /FishSense/); assert.match(html, /REEF/);
    assert.match(html, /name="email"/); assert.match(html, /name="days"/);
    assert.doesNotMatch(html, /provider-secret-never-render/);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    await setCollabAdmin(users.get('system')!, username, false);
    assert.equal((await request('/collab-manage', username)).status, 403);
  }
  const { rowCount } = await db.query("SELECT 1 FROM audit_log WHERE action = 'revoke_collab_admin'");
  assert.ok(rowCount! >= 2);
});

test('invitation is single-use, email-bound, and contains only trusted tenant/org fields', async () => {
  await setCollabAdmin(users.get('system')!, 'lead', true);
  const before = Date.now();
  const response = await request('/collab-manage', 'lead', { ...valid, fixed_data: '{"groups":["admins"]}', single_use: 'false' });
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), '/collab-manage');
  assert.equal(createPayloads.length, 1);
  assert.deepEqual(createPayloads[0].fixed_data, { 'attributes.tenant': 'fishsense', 'attributes.org': 'reef', 'attributes.invited_email': 'person@example.org' });
  assert.equal(createPayloads[0].single_use, true); assert.equal(createPayloads[0].flow, flow);
  assert.ok(Date.parse(String(createPayloads[0].expires)) >= before + 7 * 86400000);
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  const result = await request('/collab-manage', 'lead', undefined, { Cookie: cookie });
  const html = await result.text();
  assert.match(html, new RegExp(`itoken=${invitation}`));
  assert.match(html, /https:\/\/fishsense.example.test\//);
  assert.doesNotMatch(html, /provider-secret-never-render/);
  assert.equal(result.headers.get('cache-control'), 'private, no-store');
  assert.doesNotMatch(await (await request('/collab-manage', 'lead', undefined, { Cookie: cookie })).text(), /itoken=/);
  const { rows } = await db.query("SELECT details::text FROM audit_log WHERE action = 'collaborator_invite_requested'");
  assert.ok(rows.length); assert.ok(rows.every((row) => !row.details.includes(invitation)));
});

test('forged destinations, invalid email/lifetime, and a removed organization create no invite', async () => {
  await setCollabAdmin(users.get('system')!, 'lead', true);
  for (const body of [{ ...valid, destination: 'other/reef' }, { ...valid, destination: 'fishsense/unknown' }, { ...valid, email: 'invalid' }, { ...valid, days: '365' }]) {
    assert.equal((await request('/collab-manage', 'lead', body)).status, 400);
  }
  (catalog.tenants as Record<string, unknown>[])[0].organizations = [{ id: 'other', name: 'Other' }];
  assert.equal((await request('/collab-manage', 'lead', valid)).status, 400);
  assert.equal(createPayloads.length, 0);
});

test('cross-site grant and invitation requests fail before any provider mutation', async () => {
  await setCollabAdmin(users.get('system')!, 'lead', true);
  assert.equal((await request('/collab-manage', 'lead', valid, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await request('/system/v2/collab-admins', 'system', { intent: 'grant', username: 'member' }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal(createPayloads.length, 0);
});

test('provider denials and malformed catalog links fail closed without leaking response bodies', async () => {
  await setCollabAdmin(users.get('system')!, 'lead', true);
  providerStatus = 403;
  const response = await request('/collab-manage', 'lead');
  assert.equal(response.status, 503);
  assert.match(await response.text(), /check its permissions/);
  providerStatus = 200;
  (catalog.tenants as Record<string, unknown>[])[0].applications = [{ name: 'Bad', url: 'javascript:alert(1)' }];
  await assert.rejects(getCollaboratorCatalog(), /HTTPS link/);
  assert.equal(createPayloads.length, 0);
});
