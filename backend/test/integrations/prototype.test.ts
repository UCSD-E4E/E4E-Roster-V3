import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createHmac, generateKeyPairSync } from 'crypto';
import { AddressInfo } from 'net';
import { db, runMigrations } from '../../src/services/db';
import { planIntegrationSync, runIntegrationSync } from '../../src/services/integrations';
import { integrationAdapters, setIntegrationAdapters } from '../../src/integrations/providers';
import { connectionFor, resolveConnection } from '../../src/integrations/config';
import { handleSlackCommand, linkSlackIdentity } from '../../src/integrations/slack-actions';
import { setLdapTestOverrides } from '../../src/services/ldap';
import { encrypt } from '../../src/services/crypto';
import { createApp } from '../../src/app';

let alpha: number; let beta: number;
const effects: Array<{ orgId: number; service: string; target: string; identity: string }> = [];
const ldapWrites: string[] = [];
const liveAdapters = integrationAdapters();
let failProvider = false; let failLdap = false;
let server: ReturnType<ReturnType<typeof createApp>['listen']>; let base: string;

before(async () => {
  if (process.env.NODE_ENV !== 'test' || process.env.DB_NAME !== 'roster_integrations_test') throw new Error('Use the dedicated roster_integrations_test database.');
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32); process.env.SESSION_SECRET = 'prototype-tests-only';
  await runMigrations();
  await db.query('TRUNCATE orgs, users, audit_log RESTART IDENTITY CASCADE');
  const { rows } = await db.query<{ id: number }>("INSERT INTO orgs (slug,name) VALUES ('alpha','Alpha'),('beta','Beta') RETURNING id");
  [alpha, beta] = rows.map(r => r.id);
  await db.query(`INSERT INTO users (username,email,github_username,ldap_groups,expiry_date,disabled) VALUES
    ('shared','shared@example.test','shared-github',ARRAY['shared-group'],CURRENT_DATE+10,FALSE),
    ('alpha-only','alpha@example.test','alpha-github',ARRAY['shared-group'],CURRENT_DATE+10,FALSE),
    ('beta-only','beta@example.test','beta-github',ARRAY['shared-group'],CURRENT_DATE+10,FALSE),
    ('disabled','disabled@example.test','disabled-github',ARRAY['shared-group'],CURRENT_DATE+10,TRUE),
    ('expired','expired@example.test','expired-github',ARRAY['shared-group'],CURRENT_DATE-10,FALSE),
    ('legacy','legacy@example.test','legacy-github',ARRAY['shared-group'],CURRENT_DATE+10,FALSE)`);
  for (const [id, prefix] of [[alpha, 'A'], [beta, 'B']] as const) {
    await db.query("INSERT INTO org_groups (org_id,ldap_group) VALUES ($1,'shared-group')", [id]);
    for (const username of ['shared', prefix === 'A' ? 'alpha-only' : 'beta-only', 'disabled', 'expired', 'legacy']) await db.query('INSERT INTO user_orgs (org_id,username) VALUES ($1,$2)', [id, username]);
    for (const [service, config, target] of [
      ['slack', { teamId: `T${prefix}`, botToken: encrypt('fake'), appToken: encrypt('fake-app') }, 'CSAME'],
      ['github', { org: `org-${prefix}`, appId: '12', installationId: prefix === 'A' ? '101' : '102', webhookSecret: encrypt('webhook-secret') }, 'same-team'],
    ] as const) {
      await db.query('INSERT INTO org_integrations (org_id,service,config,enabled) VALUES ($1,$2,$3,TRUE)', [id, service, JSON.stringify(config)]);
      // Identical group + target names must coexist across tenants.
      await db.query("INSERT INTO group_mappings (org_id,ldap_group,service,target_id,target_name) VALUES ($1,'shared-group',$2,$3,$3)", [id, service, target]);
    }
    await db.query("INSERT INTO integration_identities (org_id,username,service,external_id) VALUES ($1,'shared','slack',$2),($1,'disabled','slack',$3)", [id, `U${prefix}SHARED`, `U${prefix}DISABLED`]);
  }
  await db.query("UPDATE users SET slack_username='UGLOBAL' WHERE username='legacy'");
  setIntegrationAdapters({
    slack: c => ({ verify: async () => {}, destinations: async () => [{ id: 'CSAME', name: 'Test' }],
      memberEmail: async id => {
        if (!id.startsWith(c.config.teamId === 'TA' ? 'UA' : 'UB')) throw new Error('Wrong workspace');
        return id.endsWith('ALPHA') ? 'alpha@example.test' : null;
      }, grant: async (target, identity) => {
        if (failProvider) throw new Error('SECRET-provider-response');
        effects.push({ orgId: c.orgId, service: 'slack', target, identity }); return 'invited';
      } }),
    github: c => ({ verify: async () => {}, destinations: async () => [], grant: async (target, identity) => {
      if (failProvider) throw new Error('SECRET-provider-response');
      effects.push({ orgId: c.orgId, service: 'github', target, identity }); return 'pending';
    } }),
  });
  setLdapTestOverrides({ updateUserExpiry: async (username, expiry) => {
    if (failLdap) return { status: 'failed', message: 'Rejected' };
    ldapWrites.push(`${username}:${expiry}`); return { status: 'success', message: 'Updated' };
  } });
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  setIntegrationAdapters(liveAdapters); setLdapTestOverrides(undefined); await db.end();
});

test('tenant plan excludes foreign members, expired/disabled accounts and legacy global Slack identities', async () => {
  const plan = await planIntegrationSync(alpha);
  assert(plan.grants.some(g => g.username === 'alpha-only'));
  assert(!plan.grants.some(g => ['beta-only','disabled','expired'].includes(g.username)));
  assert(!plan.grants.some(g => g.externalId === 'UGLOBAL'));
  assert(plan.grants.some(g => g.externalId === 'UASHARED'));
  assert(!plan.grants.some(g => g.externalId === 'UBSHARED'));
  assert(plan.skipped.some(s => s.username === 'legacy' && s.reason === 'Missing slack identity'));
  await assert.rejects(() => planIntegrationSync(undefined as unknown as number), /explicit organization/);
});

test('executing a tenant sync uses only its credentials and records pending outcomes', async () => {
  effects.length = 0;
  const result = await runIntegrationSync(alpha, 'test-admin');
  assert.equal(result.errors, 0); assert(effects.length > 0);
  assert(effects.every(e => e.orgId === alpha && e.identity !== 'beta-github'));
  const { rows } = await db.query("SELECT details FROM audit_log WHERE action='integration_grant' AND details->>'service'='github'");
  assert(rows.every(r => r.details.outcome === 'pending'));
});

test('disabled connections plan no effects and duplicate workspace bindings fail closed', async () => {
  await db.query("UPDATE org_integrations SET enabled=FALSE WHERE org_id=$1 AND service='slack'", [alpha]);
  assert(!(await planIntegrationSync(alpha)).grants.some(g => g.service === 'slack'));
  await assert.rejects(() => connectionFor(alpha, 'slack'), /not enabled/);
  await db.query("UPDATE org_integrations SET enabled=TRUE WHERE org_id=$1 AND service='slack'", [alpha]);
  await db.query("UPDATE org_integrations SET config=jsonb_set(config,'{teamId}','\"TA\"') WHERE org_id=$1 AND service='slack'", [beta]);
  await assert.rejects(() => resolveConnection('slack', 'teamId', 'TA'), /ambiguous/);
  await assert.rejects(() => connectionFor(alpha, 'slack'), /Ambiguous/);
  await db.query("UPDATE org_integrations SET config=jsonb_set(config,'{teamId}','\"TB\"') WHERE org_id=$1 AND service='slack'", [beta]);
});

test('provider failures remain failures and secrets do not enter audit history', async () => {
  failProvider = true;
  try { const result = await runIntegrationSync(alpha); assert(result.errors > 0); assert.equal(result.githubOps + result.slackOps, 0); }
  finally { failProvider = false; }
  const { rows } = await db.query("SELECT details::text FROM audit_log WHERE action='integration_grant_failed'");
  assert(rows.length > 0); assert(rows.every(r => !r.details.includes('SECRET')));
});

test('Slack routes by workspace and rejects foreign IDs, unknown workspaces and disabled accounts', async () => {
  assert.match(await handleSlackCommand('TA','UASHARED','/roster-check'), /Alpha roster: shared/);
  assert.match(await handleSlackCommand('TB','UBSHARED','/roster-check'), /Beta roster: shared/);
  await assert.rejects(() => handleSlackCommand('TB','UASHARED','/roster-check'), /Wrong workspace/);
  await assert.rejects(() => handleSlackCommand('UNKNOWN','UASHARED','/roster-check'), /Unknown/);
  await assert.rejects(() => handleSlackCommand('TA','UADISABLED','/roster-extend'), /disabled/);
  await assert.rejects(() => linkSlackIdentity(alpha, 'beta-only', 'UAOTHER', 'admin'), /does not belong/);
});

test('first command links a unique matching institutional email only inside the workspace organization', async () => {
  assert.match(await handleSlackCommand('TA','UAALPHA','/roster-check'), /alpha-only/);
  const { rows } = await db.query("SELECT org_id FROM integration_identities WHERE external_id='UAALPHA'");
  assert.deepEqual(rows, [{ org_id: alpha }]);
});

test('extension updates LDAP and the shared account once; repeated requests do not accumulate time', async () => {
  ldapWrites.length = 0;
  assert.match(await handleSlackCommand('TA','UASHARED','/roster-extend'), /across your roster organizations/);
  assert.match(await handleSlackCommand('TB','UBSHARED','/roster-extend'), /already valid/);
  assert.equal(ldapWrites.length, 1);
  const { rows: [row] } = await db.query("SELECT expiry_date=CURRENT_DATE+90 AS correct FROM users WHERE username='shared'");
  assert.equal(row.correct, true);
});

test('LDAP extension failure preserves the roster date and reports failure', async () => {
  failLdap = true;
  try { await assert.rejects(() => handleSlackCommand('TA','UAALPHA','/roster-extend'), /directory rejected/); }
  finally { failLdap = false; }
  const { rows: [row] } = await db.query("SELECT expiry_date=CURRENT_DATE+10 AS unchanged FROM users WHERE username='alpha-only'");
  assert.equal(row.unchanged, true);
});

test('signed GitHub events must match the route installation and organization', async () => {
  const payload = JSON.stringify({ installation: { id: 101 }, organization: { login: 'org-A' } });
  const headers = { 'content-type': 'application/json', 'x-github-event': 'organization',
    'x-hub-signature-256': `sha256=${createHmac('sha256','webhook-secret').update(payload).digest('hex')}` };
  assert.equal((await fetch(`${base}/webhooks/github/${alpha}`, { method: 'POST', headers, body: payload })).status, 202);
  assert.equal((await fetch(`${base}/webhooks/github/${beta}`, { method: 'POST', headers, body: payload })).status, 403);
  assert.equal((await fetch(`${base}/webhooks/github/${alpha}`, { method: 'POST', headers: { ...headers, 'x-hub-signature-256': 'invalid' }, body: payload })).status, 401);
  assert.equal((await fetch(`${base}/invite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
});

test('live GitHub adapter validates installation ownership before minting a token or granting access', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const originalFetch = globalThis.fetch; const requested: string[] = [];
  globalThis.fetch = async input => { requested.push(String(input)); return new Response(JSON.stringify({ account: { login: 'wrong-org', type: 'Organization' }, permissions: { members: 'write' } }), { status: 200 }); };
  try {
    const connection = await connectionFor(alpha, 'github');
    const provider = liveAdapters.github({ ...connection, config: { ...connection.config, privateKey: encrypt(privateKey) } });
    await assert.rejects(() => provider.grant('same-team','shared-github'), /different organization/);
    assert.equal(requested.length, 1); assert(!requested.some(url => url.includes('access_tokens')));
  } finally { globalThis.fetch = originalFetch; }
});

test('live GitHub adapter preserves existing maintainer roles and reports newly pending membership', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const originalFetch = globalThis.fetch; const methods: string[] = []; let existing = true;
  globalThis.fetch = async (input, options) => {
    const url = String(input); const method = options?.method ?? 'GET'; methods.push(method);
    const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith('/app/installations/101')) return response({ account: { login: 'org-A', type: 'Organization' }, permissions: { members: 'write' } });
    if (url.endsWith('/access_tokens')) return response({ token: 'test-installation-token' });
    if (method === 'GET') return existing ? response({ state: 'active', role: 'maintainer' }) : response({}, 404);
    assert.equal(method, 'PUT'); assert.equal(options?.body, JSON.stringify({ role: 'member' }));
    return response({ state: 'pending' });
  };
  try {
    const connection = await connectionFor(alpha, 'github');
    const configured = { ...connection, config: { ...connection.config, privateKey: encrypt(privateKey) } };
    assert.equal(await liveAdapters.github(configured).grant('same-team','shared-github'), 'active');
    assert(!methods.includes('PUT'));
    existing = false;
    assert.equal(await liveAdapters.github(configured).grant('same-team','shared-github'), 'pending');
    assert.equal(methods.filter(m => m === 'PUT').length, 1);
  } finally { globalThis.fetch = originalFetch; }
});
