import { Router, Request, Response } from 'express';
import { generateUsername } from '../../services/ldap';
import * as ldap from '../../services/ldap';
import { db } from '../../services/db';
import { syncUsers } from '../../services/sync';
import { triggerGithubInvite } from '../../services/integrations';
import { NewUser } from '../../services/types';

const router = Router();
// requireOrgAdmin is applied at admin/index.ts level

// ── User list ─────────────────────────────────────────────────────
router.get('/', async (_req: Request, res: Response) => {
  const orgId = res.locals.currentOrg?.id;
  const { rows: users } = await db.query(
    `SELECT u.username, u.first_name, u.last_name, u.email, u.role,
            TO_CHAR(u.expiry_date, 'YYYY-MM-DD') AS expiry_date,
            u.disabled, u.ldap_groups, u.github_username, u.slack_username, u.last_synced_at
     FROM users u
     JOIN user_orgs uo ON uo.username = u.username AND uo.org_id = $1
     ORDER BY u.last_name, u.first_name`,
    [orgId],
  );
  const { rows: [{ count }] } = await db.query(
    'SELECT COUNT(*) FROM user_orgs WHERE org_id = $1', [orgId],
  );
  res.render('admin/users/index', { users, totalCount: count });
});

// ── Sync ──────────────────────────────────────────────────────────
router.post('/sync', async (_req: Request, res: Response) => {
  try {
    const result = await syncUsers();
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[admin/sync]', err);
    res.status(500).json({ ok: false, message: 'Sync failed — see server logs.' });
  }
});

// ── Edit user ─────────────────────────────────────────────────────
router.get('/:username/edit', async (req: Request, res: Response) => {
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

  res.render('admin/users/edit-user', {
    user: rows[0],
    allGroups,
    sshPublicKeys: ldapUser?.sshPublicKeys ?? [],
  });
});

router.post('/:username/edit', async (req: Request, res: Response) => {
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
    return res.render('admin/users/edit-user', {
      user: rows[0],
      allGroups,
      sshPublicKeys,
      error: ldapError,
    });
  }

  const cleanGithub    = githubUsername?.trim()  || null;
  const cleanSlack     = slackUsername?.trim()   || null;
  const cleanSecondary = secondaryEmail?.trim().toLowerCase() || null;
  const cleanPhone     = phone?.trim() || null;

  await db.query(
    `UPDATE users SET
       role            = $1,
       expiry_date     = $2,
       ldap_groups     = $3,
       github_username = $4,
       slack_username  = $5,
       secondary_email = $6,
       phone           = $7,
       updated_at      = NOW()
     WHERE username = $8`,
    [role || null, expiryDate || null, selectedGroups, cleanGithub, cleanSlack,
     cleanSecondary, cleanPhone, username],
  );

  if (cleanGithub) triggerGithubInvite(cleanGithub, res.locals.currentOrg?.id as number | undefined);

  res.redirect(res.locals.orgBase + '/admin/users');
});

// ── Add existing user to org ──────────────────────────────────────
router.get('/add', async (req: Request, res: Response) => {
  const query = (req.query.q as string)?.trim() || '';
  const orgId = res.locals.currentOrg?.id as number;

  if (!query) {
    return res.render('admin/users/add', { query, found: null });
  }

  const { rows } = await db.query(
    `SELECT username, first_name, last_name, email, role
     FROM users
     WHERE username ILIKE $1 OR email ILIKE $1
     LIMIT 1`,
    [query],
  );

  if (!rows.length) {
    return res.render('admin/users/add', { query, found: null, notFound: true });
  }

  const found = rows[0];
  const { rows: existing } = await db.query(
    'SELECT role FROM user_orgs WHERE username = $1 AND org_id = $2',
    [found.username, orgId],
  );

  res.render('admin/users/add', { query, found, currentRole: existing[0]?.role ?? null });
});

router.post('/add', async (req: Request, res: Response) => {
  const { username, role } = req.body as Record<string, string>;
  const orgId = res.locals.currentOrg?.id as number;

  if (!username || !role) return res.status(400).send('Missing username or role');

  const { rows } = await db.query('SELECT username FROM users WHERE username = $1', [username]);
  if (!rows.length) return res.status(404).send('User not found');

  await db.query(
    `INSERT INTO user_orgs (username, org_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (username, org_id) DO UPDATE SET role = EXCLUDED.role`,
    [username, orgId, role],
  );

  res.redirect(res.locals.orgBase + '/admin/users');
});

// ── New user ──────────────────────────────────────────────────────
router.get('/new', async (_req: Request, res: Response) => {
  const groups = await ldap.listGroups().catch(() => []);
  res.render('admin/users/new', { groups });
});

router.post('/new', async (req: Request, res: Response) => {
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
  const sshPublicKeys = ((sshKeys as string) || '')
    .split('\n').map(k => k.trim()).filter(Boolean);

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

  // 1. Create LDAP account
  const ldapResult = await ldap.createUser(user);

  // 2. Add SSH keys if creation succeeded
  const sshResults: Array<{ preview: string; status: string; message: string }> = [];
  if (ldapResult.status !== 'failed') {
    for (const key of sshPublicKeys) {
      const r = await ldap.addSshKey(user.username, key);
      sshResults.push({ preview: key.slice(0, 40) + '…', status: r.status, message: r.message });
    }
  }

  // 3. Write to DB
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
        `UPDATE users SET github_username = $1, slack_username = $2, updated_at = NOW()
         WHERE username = $3`,
        [cleanGithub, cleanSlack, user.username],
      );
    }
    if (cleanGithub) triggerGithubInvite(cleanGithub, res.locals.currentOrg?.id as number | undefined);
  }

  res.render('admin/users/new-result', {
    user,
    ldapResult,
    sshResults,
    tempPassword: ldapResult.tempPassword,
  });
});

export default router;
