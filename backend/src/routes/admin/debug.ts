// TEMPORARY — see /DEBUG_CHANGES.md before merging to main
import { Router } from 'express';
import { listUsers, listGroups, createGroup, addSshKey, setSshKeys, addUserToGroup, removeUserFromGroup } from '../../services/ldap';

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

export default router;
