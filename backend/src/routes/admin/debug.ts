// TEMPORARY — see /DEBUG_CHANGES.md before merging to main
import { Router } from 'express';
import { listUsers, listGroups, createGroup, createUser, addSshKey, setSshKeys, addUserToGroup, removeUserFromGroup, generateUsername, updateUserGroups, updateUserExpiry } from '../../services/ldap';
import { getAllOrgs, getAllOrgLdapMappings } from '../../services/db';

const router = Router();

// List all users + their SSH keys
router.get('/ldap', async (_req, res) => {
  const t0 = Date.now();
  try {
    const users = await listUsers();
    const ms = Date.now() - t0;
    console.log(`[debug/ldap] ${users.length} users in ${ms}ms`);
    res.json({ ok: true, count: users.length, ms, users });
  } catch (err: unknown) {
    const ms = Date.now() - t0;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[debug/ldap] failed after ${ms}ms:`, message);
    res.status(500).json({ ok: false, ms, error: message });
  }
});

// List all groups
router.get('/ldap/groups', async (_req, res) => {
  const t0 = Date.now();
  try {
    const groups = await listGroups();
    const ms = Date.now() - t0;
    res.json({ ok: true, count: groups.length, ms, groups });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

// Create a new group
// POST /debug/ldap/groups  { "name": "lab-users" }
router.post('/ldap/groups', async (req, res) => {
  const { name } = req.body as { name?: string };
  if (!name) return res.status(400).json({ ok: false, error: 'name is required' });

  const result = await createGroup(name);
  res.status(result.status === 'failed' ? 500 : 200).json({ ok: result.status !== 'failed', ...result });
});

// Create a user
// POST /debug/ldap/users
// { "firstName": "Sean", "lastName": "Perry", "email": "shperry@ucsd.edu",
//   "role": "student", "expiryDate": "2027-01-01",
//   "ldapGroups": ["Domain Users"], "sshPublicKeys": ["ssh-ed25519 AAAA..."] }
router.post('/ldap/users', async (req, res) => {
  const { firstName, lastName, email, role, expiryDate, ldapGroups, sshPublicKeys } =
    req.body as Record<string, string | string[]>;

  if (!firstName || !lastName || !email || !role || !expiryDate) {
    return res.status(400).json({ ok: false, error: 'firstName, lastName, email, role, expiryDate are required' });
  }

  const user = {
    username: generateUsername(firstName as string, lastName as string, email as string),
    firstName: firstName as string,
    lastName: lastName as string,
    email: email as string,
    role: role as string,
    expiryDate: expiryDate as string,
    ldapGroups: [ldapGroups ?? []].flat(),
    sshPublicKeys: [sshPublicKeys ?? []].flat(),
    githubTeams: [],
    serverGroups: [],
  };

  const ldapResult = await createUser(user);

  const sshResults = [];
  if (ldapResult.status !== 'failed') {
    for (const key of user.sshPublicKeys) {
      const r = await addSshKey(user.username, key);
      sshResults.push({ key: key.slice(0, 40) + '…', ...r });
    }
  }

  res.status(ldapResult.status === 'failed' ? 500 : 200).json({
    ok: ldapResult.status !== 'failed',
    username: user.username,
    ldap: ldapResult,
    sshKeys: sshResults,
  });
});

// Add a user to a group
// POST /debug/ldap/groups/:groupname/members  { "username": "s.perry.543" }
router.post('/ldap/groups/:groupname/members', async (req, res) => {
  const { groupname } = req.params;
  const { username } = req.body as { username?: string };
  if (!username) return res.status(400).json({ ok: false, error: 'username is required' });

  const result = await addUserToGroup(username, groupname);
  res.status(result.status === 'success' ? 200 : 500).json({ ok: result.status === 'success', ...result });
});

// Remove a user from a group
// DELETE /debug/ldap/groups/:groupname/members/:username
router.delete('/ldap/groups/:groupname/members/:username', async (req, res) => {
  const { groupname, username } = req.params;

  const result = await removeUserFromGroup(username, groupname);
  res.status(result.status === 'success' ? 200 : 500).json({ ok: result.status === 'success', ...result });
});

// Patch a user — any combination of: groups, expiryDate, sshKeys
// PATCH /debug/ldap/users/:username
// { "groups": ["Waiter"], "expiryDate": "2028-01-01", "sshKeys": ["ssh-ed25519 AAAA..."] }
router.patch('/ldap/users/:username', async (req, res) => {
  const { username } = req.params;
  const { groups, expiryDate, sshKeys } = req.body as {
    groups?: string[];
    expiryDate?: string;
    sshKeys?: string[];
  };

  const results: Record<string, unknown> = {};

  if (groups !== undefined) {
    results.groups = await updateUserGroups(username, groups);
  }
  if (expiryDate !== undefined) {
    results.expiry = await updateUserExpiry(username, expiryDate || null);
  }
  if (sshKeys !== undefined) {
    results.sshKeys = await setSshKeys(username, sshKeys);
  }

  const failed = Object.values(results).find((r: any) => r?.status === 'failed');
  res.status(failed ? 500 : 200).json({ ok: !failed, username, ...results });
});

// Add an SSH key to a user
// POST /debug/ldap/users/:username/ssh-keys  { "key": "ssh-ed25519 AAAA..." }
router.post('/ldap/users/:username/ssh-keys', async (req, res) => {
  const { username } = req.params;
  const { key } = req.body as { key?: string };
  if (!key) return res.status(400).json({ ok: false, error: 'key is required' });

  const result = await addSshKey(username, key);
  res.status(result.status === 'success' ? 200 : 500).json({ ok: result.status === 'success', ...result });
});

// Replace all SSH keys on a user — pass empty array to remove all
// PUT /debug/ldap/users/:username/ssh-keys  { "keys": ["ssh-ed25519 AAAA..."] }
router.put('/ldap/users/:username/ssh-keys', async (req, res) => {
  const { username } = req.params;
  const { keys } = req.body as { keys?: string[] };
  if (!Array.isArray(keys)) return res.status(400).json({ ok: false, error: 'keys must be an array' });

  const result = await setSshKeys(username, keys);
  res.status(result.status === 'success' ? 200 : 500).json({ ok: result.status === 'success', ...result });
});

// List all orgs and their LDAP group mappings
router.get('/orgs', async (_req, res) => {
  try {
    const [orgs, mappings] = await Promise.all([getAllOrgs(), getAllOrgLdapMappings()]);
    res.json({ ok: true, orgs, mappings });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: message });
  }
});

export default router;
