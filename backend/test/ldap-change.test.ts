import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'ldapts';
import { createGroup, listGroups, updateUserGroups, updateUserProfile } from '../src/services/ldap';
import { notifyLdapChange } from '../src/services/ldap-change';

const directory = mkdtempSync(join(tmpdir(), 'roster-ldap-change-'));
const pending = join(directory, 'pending');
const previousPath = process.env.LDAP_CHANGE_SIGNAL_PATH;
const original = { bind: Client.prototype.bind, unbind: Client.prototype.unbind,
  search: Client.prototype.search, add: Client.prototype.add, modify: Client.prototype.modify };
const profile = { firstName: 'Test', lastName: 'Member', email: 'test@example.test' };
let writes = 0;

beforeEach(async () => {
  await rm(pending, { force: true });
  process.env.LDAP_CHANGE_SIGNAL_PATH = pending;
  process.env.LDAP_URL = 'ldap://directory.example.test';
  process.env.LDAP_USERS_DN = 'CN=Users,DC=example,DC=test';
  process.env.LDAP_GROUPS_DN = process.env.LDAP_USERS_DN;
  writes = 0;
  Client.prototype.bind = async () => {};
  Client.prototype.unbind = async () => {};
  Client.prototype.search = async () => ({ searchEntries: [{ dn: 'CN=Test,CN=Users,DC=example,DC=test', cn: 'existing', memberOf: [] }], searchReferences: [] });
  Client.prototype.add = async () => { writes++; };
  Client.prototype.modify = async () => { writes++; };
});

after(async () => {
  Object.assign(Client.prototype, original);
  if (previousPath === undefined) delete process.env.LDAP_CHANGE_SIGNAL_PATH;
  else process.env.LDAP_CHANGE_SIGNAL_PATH = previousPath;
  await rm(directory, { recursive: true, force: true });
});

test('reads, existing groups and unchanged membership do not queue a sync', async () => {
  await listGroups();
  assert.equal((await createGroup('existing')).status, 'already_exists');
  assert.equal((await updateUserGroups('test', [])).status, 'success');
  assert.equal(writes, 0);
  await assert.rejects(stat(pending), { code: 'ENOENT' });
});

test('successful group creation and profile writes queue one private, empty signal', async () => {
  assert.equal((await createGroup('new-group')).status, 'success');
  const first = await stat(pending);
  assert.equal(first.mode & 0o777, 0o600);
  assert.equal(first.size, 0);
  assert.equal((await updateUserProfile('test', profile)).status, 'success');
  assert.equal(writes, 2);
  assert.equal((await stat(pending)).ino, first.ino);
});

test('failed LDAP writes do not queue a sync', async () => {
  Client.prototype.modify = async () => { throw new Error('LDAP rejected write'); };
  assert.equal((await updateUserProfile('test', profile)).status, 'failed');
  await assert.rejects(stat(pending), { code: 'ENOENT' });
});

test('partial group changes still queue reconciliation when a later write fails', async () => {
  Client.prototype.modify = async () => { if (++writes === 2) throw new Error('Second change rejected'); };
  assert.equal((await updateUserGroups('test', ['first', 'second'])).status, 'failed');
  assert.equal(writes, 2);
  assert.equal((await stat(pending)).size, 0);
});

test('unbind failure after a successful write still queues reconciliation', async () => {
  Client.prototype.unbind = async () => { throw new Error('Connection closed'); };
  await updateUserProfile('test', profile);
  assert.equal(writes, 1);
  assert.equal((await stat(pending)).size, 0);
});

test('a missing signal mount never turns a committed LDAP write into failure', async () => {
  process.env.LDAP_CHANGE_SIGNAL_PATH = join(directory, 'missing', 'pending');
  assert.equal((await updateUserProfile('test', profile)).status, 'success');
  assert.equal(writes, 1);
});

test('an existing symlink is never followed or overwritten by the notifier', async () => {
  const target = join(directory, 'target');
  await writeFile(target, 'unchanged');
  await symlink(target, pending);
  await notifyLdapChange();
  assert.equal(await readFile(target, 'utf8'), 'unchanged');
});

test('the hook is optional when no downstream consumer is configured', async () => {
  delete process.env.LDAP_CHANGE_SIGNAL_PATH;
  assert.equal((await updateUserProfile('test', profile)).status, 'success');
  await assert.rejects(stat(pending), { code: 'ENOENT' });
});
