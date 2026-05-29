import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../../services/db';
import { generateUsername } from '../../services/ldap';
import * as ldap from '../../services/ldap';
import { syncUsers } from '../../services/sync';
import { triggerGithubInvite } from '../../services/integrations';
import { NewUser } from '../../services/types';

const router = Router();

router.get('/', (_req, res: Response) => res.redirect('/system/local-admins'));

// ── User management ───────────────────────────────────────────────────────────

router.get('/users', async (_req: Request, res: Response) => {
  const { rows: users } = await db.query(
    `SELECT username, first_name, last_name, email, role,
            TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            disabled, ldap_groups, github_username, slack_username, last_synced_at
     FROM users ORDER BY last_name, first_name`,
  );
  const { rows: [{ count }] } = await db.query('SELECT COUNT(*) FROM users');
  res.render('system/users/index', { users, totalCount: count });
});

router.post('/users/sync', async (_req: Request, res: Response) => {
  try {
    const result = await syncUsers();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[system/users/sync]', err);
    res.status(500).json({ ok: false, message: 'Sync failed — see server logs.' });
  }
});

router.get('/users/new', async (_req: Request, res: Response) => {
  const groups = await ldap.listGroups().catch(() => []);
  res.render('system/users/new', { groups });
});

router.post('/users/new', async (req: Request, res: Response) => {
  const {
    firstName, lastName, email, secondaryEmail, phone,
    role, expiryDate, ldapGroups, sshKeys, githubUsername, slackUsername,
  } = req.body as Record<string, string | string[]>;

  const cleanFirst = (firstName as string).trim();
  const cleanLast = (lastName as string).trim();
  const cleanEmail = (email as string).trim().toLowerCase();
  const cleanSecondary = (secondaryEmail as string)?.trim().toLowerCase() || null;
  const cleanPhone = (phone as string)?.trim() || null;
  const cleanGithub = (githubUsername as string)?.trim() || null;
  const cleanSlack = (slackUsername as string)?.trim() || null;
  const sshPublicKeys = ((sshKeys as string) || '').split('\n').map(k => k.trim()).filter(Boolean);

  const user: NewUser = {
    username: generateUsername(cleanFirst, cleanLast, cleanEmail),
    firstName: cleanFirst,
    lastName: cleanLast,
    email: cleanEmail,
    role: role as string,
    expiryDate: expiryDate as string,
    ldapGroups: [ldapGroups ?? []].flat(),
    sshPublicKeys,
    githubTeams: [],
    serverGroups: [],
  };

  const ldapResult = await ldap.createUser(user);

  const sshResults: Array<{ preview: string; status: string; message: string }> = [];
  if (ldapResult.status !== 'failed') {
    for (const key of sshPublicKeys) {
      const r = await ldap.addSshKey(user.username, key);
      sshResults.push({ preview: key.slice(0, 40) + '…', status: r.status, message: r.message });
    }
  }

  if (ldapResult.status === 'success' || ldapResult.status === 'already_exists') {
    await db.query(
      `INSERT INTO users
         (username, first_name, last_name, email, secondary_email, phone, role, expiry_date, ldap_groups, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()`,
      [user.username, user.firstName, user.lastName, user.email,
       cleanSecondary, cleanPhone, user.role, user.expiryDate, user.ldapGroups],
    );
    if (cleanGithub || cleanSlack) {
      await db.query(
        `UPDATE users SET github_username = $1, slack_username = $2, updated_at = NOW() WHERE username = $3`,
        [cleanGithub, cleanSlack, user.username],
      );
    }
    if (cleanGithub) triggerGithubInvite(cleanGithub, undefined);
  }

  res.render('system/users/new-result', { user, ldapResult, sshResults, tempPassword: ldapResult.tempPassword });
});

router.get('/users/:username/edit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const { rows } = await db.query(
    `SELECT username, first_name, last_name, email, secondary_email, phone, role,
            TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            disabled, ldap_groups, github_username, slack_username
     FROM users WHERE username = $1`,
    [username],
  );
  if (!rows.length) return res.status(404).send('User not found');

  const [allGroups, ldapUser] = await Promise.all([
    ldap.listGroups().catch(() => []),
    ldap.getUser(username).catch(() => null),
  ]);

  res.render('system/users/edit-user', {
    user: rows[0],
    allGroups,
    sshPublicKeys: ldapUser?.sshPublicKeys ?? [],
  });
});

router.post('/users/:username/edit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const { role, expiryDate, githubUsername, slackUsername, secondaryEmail, phone, sshKeys } =
    req.body as Record<string, string>;
  const selectedGroups: string[] = [req.body.groups ?? []].flat();
  const sshPublicKeys = (sshKeys || '').split('\n').map((k: string) => k.trim()).filter(Boolean);

  const [groupResult, expiryResult, sshResult] = await Promise.all([
    ldap.updateUserGroups(username, selectedGroups),
    ldap.updateUserExpiry(username, expiryDate || null),
    ldap.setSshKeys(username, sshPublicKeys),
  ]);

  const ldapError = [groupResult, expiryResult, sshResult]
    .find(r => r.status === 'failed')?.message ?? null;

  if (ldapError) {
    const { rows } = await db.query(
      `SELECT username, first_name, last_name, email, secondary_email, phone, role,
              TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
              disabled, ldap_groups, github_username, slack_username
       FROM users WHERE username = $1`,
      [username],
    );
    const allGroups = await ldap.listGroups().catch(() => []);
    return res.render('system/users/edit-user', { user: rows[0], allGroups, sshPublicKeys, error: ldapError });
  }

  await db.query(
    `UPDATE users SET role=$1, expiry_date=$2, ldap_groups=$3, github_username=$4,
                     slack_username=$5, secondary_email=$6, phone=$7, updated_at=NOW()
     WHERE username=$8`,
    [role || null, expiryDate || null, selectedGroups,
     githubUsername?.trim() || null, slackUsername?.trim() || null,
     secondaryEmail?.trim().toLowerCase() || null, phone?.trim() || null, username],
  );

  if (githubUsername?.trim()) triggerGithubInvite(githubUsername.trim(), undefined);

  res.redirect('/system/users');
});

// ── Group management ──────────────────────────────────────────────────────────

router.get('/groups/new', async (_req: Request, res: Response) => {
  const { rows: projects } = await db.query<{ id: number; name: string }>(
    'SELECT id, name FROM projects ORDER BY name',
  );
  const [teamsRes, channelsRes] = await Promise.allSettled([
    fetch(`${process.env.GITHUB_APP_URL ?? 'http://github-app:3001'}/teams`).then(r => r.json()),
    fetch(`${process.env.SLACK_BOT_URL  ?? 'http://slackbot:3002'}/channels`).then(r => r.json()),
  ]);
  res.render('system/groups/new', {
    projects,
    teams:    teamsRes.status    === 'fulfilled' ? (teamsRes.value    as { slug: string; name: string }[]) : [],
    channels: channelsRes.status === 'fulfilled' ? (channelsRes.value as { id: string; name: string }[])  : [],
    error: undefined,
  });
});

router.post('/groups', async (req: Request, res: Response) => {
  const { groupName, projectId, githubTeamSlug, githubTeamName, slackChannelId, slackChannelName } =
    req.body as Record<string, string>;

  const name = groupName?.trim();
  if (!name) return res.redirect('/system/groups/new?error=Group+name+is+required');

  const result = await ldap.createGroup(name);
  if (result.status === 'failed') {
    return res.redirect(`/system/groups/new?error=${encodeURIComponent(result.message)}`);
  }

  const actor = req.user?.username ?? 'system-admin';
  await db.query(
    'INSERT INTO audit_log (actor, action, details) VALUES ($1, $2, $3)',
    [actor, 'create_ldap_group', JSON.stringify({ groupName: name, alreadyExisted: result.status === 'already_exists' })],
  );

  if (projectId) {
    await db.query(
      'INSERT INTO project_ldap_groups (project_id, ldap_group) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [parseInt(projectId, 10), name],
    ).catch(() => {});
  }
  if (githubTeamSlug && githubTeamName) {
    await db.query(
      'INSERT INTO group_mappings (ldap_group, service, target_id, target_name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [name, 'github', githubTeamSlug, githubTeamName],
    );
  }
  if (slackChannelId && slackChannelName) {
    await db.query(
      'INSERT INTO group_mappings (ldap_group, service, target_id, target_name) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [name, 'slack', slackChannelId, slackChannelName],
    );
  }

  res.redirect('/system/users');
});

// ── Local admin management ────────────────────────────────────────────────────

router.get('/local-admins', async (req: Request, res: Response) => {
  const { rows } = await db.query<{
    id: number; username: string; enabled: boolean;
    last_used_at: string | null; created_at: string;
  }>('SELECT id, username, enabled, last_used_at, created_at FROM local_admins ORDER BY created_at');
  res.render('system/local-admins', { admins: rows, error: req.query['error'] });
});

router.post('/local-admins/:id/delete', async (req: Request, res: Response) => {
  await db.query('DELETE FROM local_admins WHERE id = $1', [req.params.id]);
  res.redirect('/system/local-admins');
});

router.post('/local-admins/:id/toggle', async (req: Request, res: Response) => {
  await db.query(
    'UPDATE local_admins SET enabled = NOT enabled, updated_at = NOW() WHERE id = $1',
    [req.params.id],
  );
  res.redirect('/system/local-admins');
});

// Allow creating additional local admins from the UI (e.g. for handoff)
router.post('/local-admins', async (req: Request, res: Response) => {
  const { username, password } = req.body as Record<string, string>;
  if (!username?.trim() || !password) {
    return res.redirect('/system/local-admins?error=Username+and+password+required');
  }
  const hash = await bcrypt.hash(password, 12);
  await db.query(
    `INSERT INTO local_admins (username, password_hash) VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, enabled = TRUE, updated_at = NOW()`,
    [username.trim(), hash],
  );
  res.redirect('/system/local-admins');
});

// ── Org management ────────────────────────────────────────────────────────────

router.get('/orgs', async (req: Request, res: Response) => {
  const { rows: orgs } = await db.query(`
    SELECT o.id, o.slug, o.name, o.description,
           COUNT(uo.username)::text AS member_count
    FROM orgs o
    LEFT JOIN user_orgs uo ON uo.org_id = o.id
    GROUP BY o.id ORDER BY o.name
  `);
  res.render('system/orgs', { orgs, error: req.query['error'] });
});

router.post('/orgs', async (req: Request, res: Response) => {
  const { slug, name, description, themeColor } = req.body as Record<string, string>;
  if (!slug?.trim() || !name?.trim()) {
    return res.redirect('/system/orgs?error=Slug+and+name+required');
  }
  // Strict hex regex prevents CSS injection — only #RRGGBB values reach the template.
  const color = /^#[0-9A-Fa-f]{6}$/.test(themeColor ?? '') ? themeColor : null;
  await db.query(
    'INSERT INTO orgs (slug, name, description, theme_color) VALUES ($1, $2, $3, $4)',
    [slug.trim().toLowerCase(), name.trim(), description?.trim() || null, color],
  );
  res.redirect('/system/orgs');
});

router.post('/orgs/:id/theme', async (req: Request, res: Response) => {
  const { themeColor } = req.body as { themeColor?: string };
  if (!themeColor || !/^#[0-9A-Fa-f]{6}$/.test(themeColor)) { // same hex guard as create
    return res.redirect('/system/orgs?error=Invalid+color+value');
  }
  await db.query('UPDATE orgs SET theme_color = $1 WHERE id = $2', [themeColor, req.params.id]);
  res.redirect('/system/orgs');
});

router.post('/orgs/:id/delete', async (req: Request, res: Response) => {
  await db.query('DELETE FROM orgs WHERE id = $1', [req.params.id]);
  res.redirect('/system/orgs');
});

// ── LDAP group → org role mappings ────────────────────────────────────────────

router.get('/orgs/:id/ldap-mappings', async (req: Request, res: Response) => {
  const orgId = parseInt(req.params.id, 10);
  const [{ rows: [org] }, { rows: mappings }] = await Promise.all([
    db.query('SELECT id, slug, name FROM orgs WHERE id = $1', [orgId]),
    db.query(
      'SELECT id, ldap_group, role FROM org_ldap_group_mappings WHERE org_id = $1 ORDER BY role, ldap_group',
      [orgId],
    ),
  ]);
  if (!org) return res.status(404).send('Org not found');
  res.render('system/ldap-mappings', { org, mappings, error: req.query['error'] });
});

router.post('/orgs/:id/ldap-mappings', async (req: Request, res: Response) => {
  const orgId = parseInt(req.params.id, 10);
  const { ldapGroup, role } = req.body as Record<string, string>;
  if (!ldapGroup?.trim() || !role) {
    return res.redirect(`/system/orgs/${orgId}/ldap-mappings?error=Group+and+role+required`);
  }
  await db.query(
    `INSERT INTO org_ldap_group_mappings (org_id, ldap_group, role)
     VALUES ($1, $2, $3) ON CONFLICT (org_id, ldap_group) DO UPDATE SET role = EXCLUDED.role`,
    [orgId, ldapGroup.trim(), role],
  );
  res.redirect(`/system/orgs/${orgId}/ldap-mappings`);
});

router.post('/orgs/:id/ldap-mappings/:mappingId/delete', async (req: Request, res: Response) => {
  await db.query('DELETE FROM org_ldap_group_mappings WHERE id = $1', [req.params.mappingId]);
  res.redirect(`/system/orgs/${req.params.id}/ldap-mappings`);
});

export default router;
