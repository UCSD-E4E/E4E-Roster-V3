import { Router, Request, Response } from 'express';
import { requireAdmin } from '../../middleware/requireAdmin';
import { generateUsername } from '../../services/ldap';
import * as udm from '../../services/udm';
import { db } from '../../services/db';
import { syncUsers } from '../../services/sync';
import { NewUser } from '../../services/types';

const router = Router();
router.use(requireAdmin);

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
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, message });
  }
});

// ── Edit user (role, expiry, groups) ─────────────────────────────
router.get('/:username/edit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const { rows } = await db.query(
    `SELECT username, first_name, last_name, email, role,
            TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            disabled, ldap_groups, github_username, slack_username
     FROM users WHERE username = $1`,
    [username],
  );
  if (!rows.length) return res.status(404).send('User not found');

  let allGroups: string[] = [];
  try {
    allGroups = await udm.listGroups();
  } catch (err) {
    console.error('[admin] Failed to fetch groups:', err);
  }

  res.render('admin/users/edit-user', { user: rows[0], allGroups });
});

router.post('/:username/edit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const { role, expiryDate, githubUsername, slackUsername } = req.body as Record<string, string>;
  const selectedGroups: string[] = [req.body.groups ?? []].flat();

  // Update groups in UDM
  const groupResult = await udm.updateUserGroups(username, selectedGroups);

  // Update expiry in UDM (always — empty string clears it)
  let udmError: string | null = null;
  if (groupResult.status === 'failed') {
    udmError = groupResult.message;
  } else {
    const expiryResult = await udm.updateUserExpiry(username, expiryDate ?? '');
    if (expiryResult.status === 'failed') udmError = expiryResult.message;
  }

  if (udmError) {
    const { rows } = await db.query(
      `SELECT username, first_name, last_name, email, role,
              TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
              disabled, ldap_groups, github_username, slack_username
       FROM users WHERE username = $1`,
      [username],
    );
    const allGroups = await udm.listGroups().catch(() => []);
    return res.render('admin/users/edit-user', { user: rows[0], allGroups, error: udmError });
  }

  const cleanGithub = githubUsername?.trim() || null;
  const cleanSlack = slackUsername?.trim() || null;

  // Update DB immediately
  await db.query(
    `UPDATE users SET
       role            = $1,
       expiry_date     = $2,
       ldap_groups     = $3,
       github_username = $4,
       slack_username  = $5,
       updated_at      = NOW()
     WHERE username = $6`,
    [role || null, expiryDate || null, selectedGroups, cleanGithub, cleanSlack, username],
  );

  // Write Slack/GitHub/role back to LDAP extended attributes (non-fatal)
  const cleanRole = role || null;
  const ldapFields: { slackId?: string | null; githubUsername?: string | null; role?: string | null } = {};
  if (cleanSlack !== null) ldapFields.slackId = cleanSlack;
  if (cleanGithub !== null) ldapFields.githubUsername = cleanGithub;
  if (cleanRole !== null) ldapFields.role = cleanRole;
  if (Object.keys(ldapFields).length > 0) {
    udm.updateUserLdapFields(username, ldapFields).catch((err) =>
      console.warn(`[admin] LDAP write-back failed for ${username}:`, err),
    );
  }

  res.redirect('/admin/users');
});

// ── New user wizard ───────────────────────────────────────────────

// Step 1: SSO form
router.get('/new', async (req: Request, res: Response) => {
  delete req.session.wizard;

  let groups: string[] = [];
  try {
    groups = await udm.listGroups();
  } catch (err) {
    console.error('[admin] Failed to fetch groups from UDM:', err);
  }

  res.render('admin/users/new/step1', { groups });
});

// Step 1 submit: create SSO account
router.post('/new/sso', async (req: Request, res: Response) => {
  const { firstName, lastName, email, role, expiryDate, ldapGroups } =
    req.body as Record<string, string | string[]>;

  const cleanEmail = (email as string).trim().toLowerCase();
  const cleanFirst = (firstName as string).trim();
  const cleanLast = (lastName as string).trim();

  const user: NewUser = {
    username: generateUsername(cleanFirst, cleanLast, cleanEmail),
    firstName: cleanFirst,
    lastName: cleanLast,
    email: cleanEmail,
    role: role as string,
    expiryDate: expiryDate as string,
    ldapGroups: [ldapGroups ?? []].flat(),
    githubTeams: [],
    serverGroups: [],
  };

  const result = await udm.createUser(user);

  // Persist to DB on success so the roster is up-to-date immediately
  if (result.status === 'success') {
    await db.query(
      `INSERT INTO users (username, first_name, last_name, email, role, expiry_date, ldap_groups, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (username) DO UPDATE SET
         role = EXCLUDED.role, updated_at = NOW()`,
      [user.username, user.firstName, user.lastName, user.email, user.role, user.expiryDate, user.ldapGroups],
    );
    // Write role to LDAP extended attribute immediately (non-fatal)
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
    nextUrl: '/admin/users/new/github-slack',
  });
});

// Step 2: GitHub + Slack
router.get('/new/github-slack', (req: Request, res: Response) => {
  if (!req.session.wizard?.steps.sso) return res.redirect('/admin/users/new');
  res.render('admin/users/new/step2', { wizard: req.session.wizard });
});

router.post('/new/github-slack', async (req: Request, res: Response) => {
  if (!req.session.wizard?.steps.sso) return res.redirect('/admin/users/new');

  const { githubUsername, slackUsername } = req.body as Record<string, string>;
  const { username } = req.session.wizard.user;

  const cleanGithub = githubUsername?.trim() || null;
  const cleanSlack = slackUsername?.trim() || null;

  await db.query(
    `UPDATE users SET github_username = $1, slack_username = $2, updated_at = NOW()
     WHERE username = $3`,
    [cleanGithub, cleanSlack, username],
  );

  // Write to LDAP extended attributes (non-fatal — user can be linked later)
  if (cleanGithub || cleanSlack) {
    const ldapFields: { slackId?: string | null; githubUsername?: string | null } = {};
    if (cleanSlack) ldapFields.slackId = cleanSlack;
    if (cleanGithub) ldapFields.githubUsername = cleanGithub;
    udm.updateUserLdapFields(username, ldapFields).catch((err) =>
      console.warn(`[wizard] LDAP write-back failed for ${username}:`, err),
    );
  }

  res.redirect('/admin/users/new/server');
});

// Step 3: Server access (stub)
router.get('/new/server', (req: Request, res: Response) => {
  if (!req.session.wizard?.steps.sso) return res.redirect('/admin/users/new');
  res.render('admin/users/new/step3', { wizard: req.session.wizard });
});

export default router;
