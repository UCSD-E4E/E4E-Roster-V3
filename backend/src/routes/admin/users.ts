import { Router, Request, Response } from 'express';
import { generateUsername } from '../../services/ldap';
import * as udm from '../../services/udm';
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

  const allGroups = await udm.listGroups().catch(() => []);
  res.render('admin/users/edit-user', { user: rows[0], allGroups });
});

router.post('/:username/edit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const { role, expiryDate, githubUsername, slackUsername, secondaryEmail, phone } =
    req.body as Record<string, string>;
  const selectedGroups: string[] = [req.body.groups ?? []].flat();

  const groupResult = await udm.updateUserGroups(username, selectedGroups);
  let udmError: string | null = null;
  if (groupResult.status === 'failed') {
    udmError = groupResult.message;
  } else {
    const expiryResult = await udm.updateUserExpiry(username, expiryDate ?? '');
    if (expiryResult.status === 'failed') udmError = expiryResult.message;
  }

  if (udmError) {
    const { rows } = await db.query(
      `SELECT username, first_name, last_name, email, secondary_email, phone, role,
              TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
              disabled, ldap_groups, github_username, slack_username
       FROM users WHERE username = $1`,
      [username],
    );
    const allGroups = await udm.listGroups().catch(() => []);
    return res.render('admin/users/edit-user', { user: rows[0], allGroups, error: udmError });
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

  udm.updateUserLdapFields(username, {
    ...(cleanSlack    !== null && { slackId: cleanSlack }),
    ...(cleanGithub   !== null && { githubUsername: cleanGithub }),
    ...(role          && { role }),
    secondaryEmail: cleanSecondary,
    phone: cleanPhone,
  }).catch((err) => console.warn(`[admin] LDAP write-back failed for ${username}:`, err));

  if (cleanGithub) triggerGithubInvite(cleanGithub, res.locals.currentOrg?.id as number | undefined, 'admin');

  res.redirect(res.locals.orgBase + '/admin/users');
});

// ── New user wizard ───────────────────────────────────────────────
router.get('/new', async (req: Request, res: Response) => {
  delete req.session.wizard;
  const groups = await udm.listGroups().catch(() => []);
  res.render('admin/users/new/step1', { groups });
});

router.post('/new/sso', async (req: Request, res: Response) => {
  const { firstName, lastName, email, secondaryEmail, phone, role, expiryDate, ldapGroups } =
    req.body as Record<string, string | string[]>;

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
    githubTeams: [],
    serverGroups: [],
  };

  const result = await udm.createUser(user);

  if (result.status === 'success') {
    await db.query(
      `INSERT INTO users
         (username, first_name, last_name, email, secondary_email, phone, role, expiry_date, ldap_groups, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()`,
      [user.username, user.firstName, user.lastName, user.email,
       cleanSecondary, cleanPhone, user.role, user.expiryDate, user.ldapGroups],
    );
    if (user.role) {
      udm.updateUserLdapFields(user.username, { role: user.role }).catch((err) =>
        console.warn(`[wizard] LDAP role write-back failed for ${user.username}:`, err),
      );
    }
  }

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

export default router;
