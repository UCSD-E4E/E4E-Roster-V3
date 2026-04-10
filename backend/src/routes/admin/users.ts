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
            disabled, ldap_groups, last_synced_at
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
            disabled, ldap_groups
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
  const { role, expiryDate } = req.body as Record<string, string>;
  const selectedGroups: string[] = [req.body.groups ?? []].flat();

  // Update groups in UDM
  const groupResult = await udm.updateUserGroups(username, selectedGroups);

  // Update expiry in UDM (only if provided)
  let udmError: string | null = null;
  if (groupResult.status === 'failed') {
    udmError = groupResult.message;
  } else if (expiryDate) {
    const expiryResult = await udm.updateUserExpiry(username, expiryDate);
    if (expiryResult.status === 'failed') udmError = expiryResult.message;
  }

  if (udmError) {
    const { rows } = await db.query(
      `SELECT username, first_name, last_name, email, role,
              TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
              disabled, ldap_groups
       FROM users WHERE username = $1`,
      [username],
    );
    const allGroups = await udm.listGroups().catch(() => []);
    return res.render('admin/users/edit-user', { user: rows[0], allGroups, error: udmError });
  }

  // Update DB immediately
  await db.query(
    `UPDATE users SET
       role        = $1,
       expiry_date = $2,
       ldap_groups = $3,
       updated_at  = NOW()
     WHERE username = $4`,
    [role || null, expiryDate || null, selectedGroups, username],
  );

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
  }

  req.session.wizard = { user, steps: { sso: result } };

  res.render('admin/users/new/step1-result', {
    user,
    result,
    nextUrl: '/admin/users/new/github-slack',
  });
});

// Step 2: GitHub + Slack (stub)
router.get('/new/github-slack', (req: Request, res: Response) => {
  if (!req.session.wizard?.steps.sso) return res.redirect('/admin/users/new');
  res.render('admin/users/new/step2', { wizard: req.session.wizard });
});

// Step 3: Server access (stub)
router.get('/new/server', (req: Request, res: Response) => {
  if (!req.session.wizard?.steps.sso) return res.redirect('/admin/users/new');
  res.render('admin/users/new/step3', { wizard: req.session.wizard });
});

export default router;
