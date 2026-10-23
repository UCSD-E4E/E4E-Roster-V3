import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { AddressInfo } from 'net';
import { db, runMigrations } from '../../src/services/db';
import { scanSlackOnboarding, completeSlackOnboarding, notifyOrganizationJoin, onboardingTokenHash, onboardingDetails, userRequestedOnboarding, runDueSlackOnboarding } from '../../src/integrations/onboarding';
import { setIntegrationAdapters } from '../../src/integrations/providers';
import { setLdapTestOverrides } from '../../src/services/ldap';
import { createApp } from '../../src/app';
import { setupPassportSession } from '../../src/auth';
import passport from 'passport';
import type { AuthUser } from '../../src/types/user';

let alpha: number; let beta: number; let origin: string;
let server: ReturnType<ReturnType<typeof createApp>['listen']>;
let failMessages = false;
const dms: Array<{ orgId: number; id: string; text: string }> = [];
const messages: Array<{ orgId: number; channel: string; text: string }> = [];
const members = [
  { id: 'UNEW', email: 'new@example.test' },
  { id: 'UEXISTING', email: 'existing@example.test' },
  { id: 'UDISABLED', email: 'disabled@example.test' },
  { id: 'UOTHER', email: 'other@example.test' },
];
const user = (username: string, email: string): AuthUser => ({ id: username, username, email, name: username, groups: [], orgs: [], isSystemAdmin: false });
const invitation = (orgId: number, id = 'UNEW') => {
  const message = dms.find(m => m.orgId === orgId && m.id === id);
  assert(message); const match = message.text.match(/\/connect\/slack\/([a-f0-9]{64})/); assert(match); return match[1];
};

before(async () => {
  if (process.env.NODE_ENV !== 'test' || process.env.DB_NAME !== 'roster_onboarding_test') throw new Error('Use roster_onboarding_test only.');
  process.env.SESSION_SECRET = 'isolated-onboarding-tests';
  process.env.ROSTER_BASE_URL = 'http://127.0.0.1:3100';
  await runMigrations();
  await db.query('TRUNCATE orgs,users,audit_log RESTART IDENTITY CASCADE');
  const { rows } = await db.query<{ id: number }>("INSERT INTO orgs (slug,name) VALUES ('alpha','Alpha'),('beta','Beta') RETURNING id");
  [alpha,beta] = rows.map(r => r.id);
  await db.query(`INSERT INTO users (username,email,disabled) VALUES ('existing','existing@example.test',FALSE),('disabled','disabled@example.test',TRUE)`);
  await db.query(`INSERT INTO user_orgs (org_id,username,role) VALUES ($1,'existing','org_admin'),($1,'disabled','member')`, [alpha]);
  for (const [id,team,channel] of [[alpha,'TA','CALPHA'],[beta,'TB','CBETA']] as const) {
    await db.query(`INSERT INTO org_integrations (org_id,service,enabled,config) VALUES ($1,'slack',TRUE,$2)`,
      [id,JSON.stringify({ teamId: team, onboardingEnabled: 'true', onboardingChannelId: channel })]);
  }
  setIntegrationAdapters({ slack: connection => ({ verify: async () => {}, destinations: async () => [], grant: async () => { throw new Error('Onboarding must not grant resources'); },
    members: async () => members,
    memberEmail: async id => members.find(m => m.id === id)?.email ?? null,
    directMessage: async (id,text) => { dms.push({ orgId: connection.orgId,id,text }); },
    sendMessage: async (channel,text) => { if (failMessages) throw new Error('Unavailable'); messages.push({ orgId: connection.orgId,channel,text }); },
  }), github: () => ({ verify: async () => {}, destinations: async () => [], grant: async () => { throw new Error('Onboarding must not grant resources'); } }) });
  setLdapTestOverrides({ getUser: async username => ({ username, firstName: 'New', lastName: 'Member', email: username === 'new' ? 'new@example.test' : 'other@example.test',
    disabled: false, groups: [], expiryDate: null, sshPublicKeys: [], dn: `CN=${username}` }) });
  setupPassportSession();
  // Exercise the real callback and Passport session regeneration without contacting an OIDC provider.
  passport.use('oidc', { authenticate() { this.success(user('browser','other@example.test')); } } as passport.Strategy);
  server = createApp().listen(0,'127.0.0.1');
  await new Promise<void>(resolve => server.once('listening',resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  setLdapTestOverrides(undefined); await db.end();
});

test('weekly scan invites only missing active people; repeated scans send no reminders', async () => {
  assert.deepEqual(await scanSlackOnboarding(alpha), { invited: 2, skipped: 2, failed: 0 });
  assert.deepEqual(await scanSlackOnboarding(alpha), { invited: 0, skipped: 4, failed: 0 });
  assert.equal(dms.length,2); assert(dms.every(m => m.orgId === alpha));
  const { rows: [stored] } = await db.query("SELECT token_hash,expires_at>NOW() AS valid FROM slack_onboarding WHERE org_id=$1 AND slack_user_id='UNEW'",[alpha]);
  assert.equal(stored.token_hash,onboardingTokenHash(invitation(alpha))); assert.equal(stored.valid,true);
  assert.notEqual(stored.token_hash,invitation(alpha));
  const count = dms.length; await runDueSlackOnboarding();
  // Beta is due; Alpha is not scanned again.
  assert(dms.slice(count).every(m => m.orgId === beta));
});

test('new member gets regular membership, scoped Slack link, pending GitHub username and exactly one existing Edit User notification', async () => {
  const account = user('new','new@example.test');
  const result = await completeSlackOnboarding(onboardingTokenHash(invitation(alpha)),account,'octocat');
  assert.equal(result.joined,true);
  const { rows: memberships } = await db.query('SELECT org_id,role FROM user_orgs WHERE username=$1',['new']);
  assert.deepEqual(memberships,[{ org_id: alpha,role: 'member' }]);
  const { rows: [profile] } = await db.query("SELECT github_username,github_username_pending,ldap_groups FROM users WHERE username='new'");
  assert.deepEqual(profile,{ github_username: null,github_username_pending: 'octocat',ldap_groups: [] });
  assert.equal(messages.length,1); assert.equal(messages[0].channel,'CALPHA');
  assert(messages[0].text.includes('/orgs/alpha/v2/people/new/edit'));
  assert.equal(account.orgs[0].orgId,alpha);
  await notifyOrganizationJoin(alpha,'new'); assert.equal(messages.length,1);
  await assert.rejects(() => completeSlackOnboarding(onboardingTokenHash(invitation(alpha)),account,'octocat'),/expired|used/);
  assert.equal(messages.length,1);
});

test('existing organization member reconnects quietly and keeps their existing role', async () => {
  const response = await userRequestedOnboarding(alpha,'UEXISTING');
  const token = response.match(/\/connect\/slack\/([a-f0-9]{64})/)![1];
  const result = await completeSlackOnboarding(onboardingTokenHash(token),user('existing','existing@example.test'),'existing-github');
  assert.equal(result.joined,false); assert.equal(messages.length,1);
  const { rows: [membership] } = await db.query("SELECT role FROM user_orgs WHERE org_id=$1 AND username='existing'",[alpha]);
  assert.equal(membership.role,'org_admin');
});

test('joining a second organization reuses the roster account and notifies only that organization channel', async () => {
  await completeSlackOnboarding(onboardingTokenHash(invitation(beta)),user('new','new@example.test'),'octocat');
  assert.equal(messages.length,2); assert.equal(messages[1].channel,'CBETA');
  const { rows: [count] } = await db.query("SELECT COUNT(*)::int AS count FROM users WHERE username='new'"); assert.equal(count.count,1);
});

test('notification delivery failure is recorded and never automatically retried', async () => {
  await db.query("INSERT INTO user_orgs (org_id,username) VALUES ($1,'existing') ON CONFLICT DO NOTHING",[beta]);
  failMessages = true;
  await notifyOrganizationJoin(beta,'existing');
  failMessages = false;
  await notifyOrganizationJoin(beta,'existing');
  assert.equal(messages.length,2);
  const { rows: [state] } = await db.query("SELECT status FROM org_join_notifications WHERE org_id=$1 AND username='existing'",[beta]);
  assert.equal(state.status,'failed');
});

test('wrong account, malformed GitHub username, disabled account and disabled connection cannot claim invitations', async () => {
  const hash = onboardingTokenHash(invitation(alpha,'UOTHER'));
  await assert.rejects(() => completeSlackOnboarding(hash,user('new','new@example.test'),'octocat'),/email addresses differ/);
  await assert.rejects(() => completeSlackOnboarding(hash,user('other','other@example.test'),'https://github.com/octocat'),/valid GitHub/);
  await assert.rejects(() => completeSlackOnboarding(hash,user('disabled','disabled@example.test'),'octocat'),/active directory/);
  await db.query("UPDATE org_integrations SET enabled=FALSE WHERE org_id=$1 AND service='slack'",[alpha]);
  await assert.rejects(() => onboardingDetails(hash),/unavailable/);
  await db.query("UPDATE org_integrations SET enabled=TRUE WHERE org_id=$1 AND service='slack'",[alpha]);
});

test('expired links are replaced only on user request and old tokens stop working', async () => {
  const oldToken = invitation(alpha,'UOTHER');
  await db.query("UPDATE slack_onboarding SET expires_at=NOW()-INTERVAL '1 day' WHERE token_hash=$1",[onboardingTokenHash(oldToken)]);
  await assert.rejects(() => onboardingDetails(onboardingTokenHash(oldToken)),/expired/);
  const reply = await userRequestedOnboarding(alpha,'UOTHER'); const newToken = reply.match(/\/connect\/slack\/([a-f0-9]{64})/)![1];
  assert.notEqual(oldToken,newToken);
  await assert.rejects(() => onboardingDetails(onboardingTokenHash(oldToken)),/expired/);
  assert.equal((await onboardingDetails(onboardingTokenHash(newToken))).org_id,alpha);
});

test('browser invitation survives actual login/session regeneration; GET does not claim and cross-site POST is rejected', async () => {
  const reply = await userRequestedOnboarding(alpha,'UOTHER'); const token = reply.match(/\/connect\/slack\/([a-f0-9]{64})/)![1];
  let cookie = '';
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(origin+path,{ ...init, redirect: 'manual', headers: { Cookie: cookie,...init.headers } });
    const setCookie = response.headers.get('set-cookie'); if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  const opened = await request(`/connect/slack/${token}`); assert.equal(opened.status,302); assert.equal(opened.headers.get('location'),'/connect/slack');
  const anonymous = await request('/connect/slack'); assert.match(await anonymous.text(),/Sign in with SSO/);
  await onboardingDetails(onboardingTokenHash(token));
  const callback = await request('/auth/callback'); assert.equal(callback.headers.get('location'),'/connect/slack');
  const signedIn = await request('/connect/slack'); assert.match(await signedIn.text(),/browser/);
  const blocked = await request('/connect/slack',{ method: 'POST',headers: { Origin: 'https://wrong.example','Content-Type': 'application/x-www-form-urlencoded' },body: 'githubUsername=octocat' });
  assert.equal(blocked.status,403);
  const completed = await request('/connect/slack',{ method: 'POST',headers: { Origin: origin,'Content-Type': 'application/x-www-form-urlencoded' },body: 'githubUsername=octocat' });
  assert.equal(completed.status,200); assert.match(await completed.text(),/Your account is connected/);
  assert.equal(messages.length,3);
});
