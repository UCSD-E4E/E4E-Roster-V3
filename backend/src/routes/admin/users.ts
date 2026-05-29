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
  const { rows: users } = await db.query(
    `SELECT username, first_name, last_name, email, role,
            TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            disabled, ldap_groups, github_username, slack_username, last_synced_at
     FROM users
     ORDER BY last_name, first_name`,
  );
  const { rows: [{ count }] } = await db.query('SELECT COUNT(*) FROM users');
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

<<<<<<< HEAD
  const allGroups = await udm.listGroups().catch(() => []);
  res.render('admin/users/edit-user', { user: rows[0], allGroups });
=======
  const [allGroups, ldapUser] = await Promise.all([
    ldap.listGroups().catch(() => []),
    ldap.getUser(username).catch(() => null),
  ]);

  res.render('admin/users/edit-user', {
    user: rows[0],
    allGroups,
    sshPublicKeys: ldapUser?.sshPublicKeys ?? [],
  });
>>>>>>> main
});

router.post('/:username/edit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const { role, expiryDate, githubUsername, slackUsername, secondaryEmail, phone, sshKeys } =
    req.body as Record<string, string>;
  const selectedGroups: string[] = [req.body.groups ?? []].flat();
  const sshPublicKeys = (sshKeys || '').split('\n').map((k: string) => k.trim()).filter(Boolean);

<<<<<<< HEAD
  const groupResult = await udm.updateUserGroups(username, selectedGroups);
  let udmError: string | null = null;
  if (groupResult.status === 'failed') {
    udmError = groupResult.message;
  } else {
    const expiryResult = await udm.updateUserExpiry(username, expiryDate ?? '');
    if (expiryResult.status === 'failed') udmError = expiryResult.message;
  }
=======
  const [groupResult, expiryResult, sshResult] = await Promise.all([
    ldap.updateUserGroups(username, selectedGroups),
    ldap.updateUserExpiry(username, expiryDate || null),
    ldap.setSshKeys(username, sshPublicKeys),
  ]);

  const ldapError = [groupResult, expiryResult, sshResult]
    .find(r => r.status === 'failed')?.message ?? null;
>>>>>>> main

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

<<<<<<< HEAD
  udm.updateUserLdapFields(username, {
    ...(cleanSlack    !== null && { slackId: cleanSlack }),
    ...(cleanGithub   !== null && { githubUsername: cleanGithub }),
    ...(role          && { role }),
    secondaryEmail: cleanSecondary,
    phone: cleanPhone,
  }).catch((err) => console.warn(`[admin] LDAP write-back failed for ${username}:`, err));

  if (cleanGithub) triggerGithubInvite(cleanGithub, res.locals.currentOrg?.id as number | undefined, 'admin');
=======
  if (cleanGithub) triggerGithubInvite(cleanGithub);
>>>>>>> main

  res.redirect(res.locals.orgBase + '/admin/users');
});

<<<<<<< HEAD
// ── New user wizard ───────────────────────────────────────────────
router.get('/new', async (req: Request, res: Response) => {
  delete req.session.wizard;
  const groups = await udm.listGroups().catch(() => []);
  res.render('admin/users/new/step1', { groups });
=======
// ── New user ──────────────────────────────────────────────────────
router.get('/new', async (_req: Request, res: Response) => {
  const groups = await ldap.listGroups().catch(() => []);
  res.render('admin/users/new', { groups });
>>>>>>> main
});

router.post('/new', async (req: Request, res: Response) => {
  const {
    firstName, lastName, email, secondaryEmail, phone,
    role, expiryDate, ldapGroups, sshKeys, githubUsername, slackUsername,
  } = req.body as Record<string, string | string[]>;

<<<<<<< HEAD
  const cleanEmail     = (email as string).trim().toLowerCase();
  const cleanFirst     = (firstName as string).trim();
  const cleanLast      = (lastName as string).trim();
  const cleanSecondary = (secondaryEmail as string)?.trim().toLowerCase() || null;
  const cleanPhone     = (phone as string)?.trim() || null;

  const user: NewUser = {
    username:    generateUsername(cleanFirst, cleanLast, cleanEmail),
    firstName:   cleanFirst,
    lastName:    cleanLast,
    email:       cleanEmail,
    role:        role as string,
    expiryDate:  expiryDate as string,
    ldapGroups:  [ldapGroups ?? []].flat(),
=======
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
>>>>>>> main
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
    if (cleanGithub) triggerGithubInvite(cleanGithub);
  }

<<<<<<< HEAD
  req.session.wizard = { user, steps: { sso: result } };
  res.render('admin/users/new/step1-result', {
    user,
    result,
    nextUrl: res.locals.orgBase + '/admin/users/new/github-slack',
  });
});

router.get('/new/github-slack', (req: Request, res: Response) => {
  if (!req.session.wizard?.steps.sso) {
    return res.redirect(res.locals.orgBase + '/admin/users/new');
  }
  res.render('admin/users/new/step2', { wizard: req.session.wizard });
});

router.post('/new/github-slack', async (req: Request, res: Response) => {
  if (!req.session.wizard?.steps.sso) {
    return res.redirect(res.locals.orgBase + '/admin/users/new');
  }

  const { githubUsername, slackUsername } = req.body as Record<string, string>;
  const { username } = req.session.wizard.user;
  const cleanGithub = githubUsername?.trim() || null;
  const cleanSlack  = slackUsername?.trim()  || null;

  await db.query(
    'UPDATE users SET github_username = $1, slack_username = $2, updated_at = NOW() WHERE username = $3',
    [cleanGithub, cleanSlack, username],
  );

  if (cleanGithub || cleanSlack) {
    const ldapFields: { slackId?: string | null; githubUsername?: string | null } = {};
    if (cleanSlack)  ldapFields.slackId       = cleanSlack;
    if (cleanGithub) ldapFields.githubUsername = cleanGithub;
    udm.updateUserLdapFields(username, ldapFields).catch((err) =>
      console.warn(`[wizard] LDAP write-back failed for ${username}:`, err),
    );
  }

  if (cleanGithub) triggerGithubInvite(cleanGithub, res.locals.currentOrg?.id as number | undefined, 'admin-wizard');
  res.redirect(res.locals.orgBase + '/admin/users/new/server');
});

router.get('/new/server', (req: Request, res: Response) => {
  if (!req.session.wizard?.steps.sso) {
    return res.redirect(res.locals.orgBase + '/admin/users/new');
  }
  res.render('admin/users/new/step3', { wizard: req.session.wizard });
});
=======
  res.render('admin/users/new-result', {
    user,
    ldapResult,
    sshResults,
    tempPassword: ldapResult.tempPassword,
  });
});

// ── Helpers ───────────────────────────────────────────────────────
function triggerGithubInvite(githubUsername: string): void {
  const base = process.env.GITHUB_APP_URL ?? 'http://github-app:3001';
  fetch(`${base}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ githubUsername }),
  }).catch((err) => console.warn(`[admin] GitHub invite trigger failed for ${githubUsername}:`, err));
}
>>>>>>> main

export default router;
