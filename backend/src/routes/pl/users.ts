/**
 * PL portal user management routes.
 * All routes are scoped to a specific project; the middleware validates that
 * the logged-in user has access to that project before any handler runs.
 */
import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../services/db';
import * as udm from '../../services/udm';
import { generateUsername } from '../../services/ldap';
import { NewUser } from '../../services/types';

const router = Router({ mergeParams: true });

// ── Guard: ensure the PL belongs to this project ──────────────────

async function requireProjectAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).send('Invalid project ID'); return; }

  const userGroups: string[] = req.user?.groups ?? [];

  // Admins bypass the group check
  if (req.user?.isAdmin) {
    const { rows } = await db.query<{ id: number; name: string }>(
      `SELECT id, name FROM projects WHERE id = $1`, [projectId],
    );
    if (!rows[0]) { res.status(404).send('Project not found'); return; }
    res.locals.project = rows[0];
    return next();
  }

  const { rows } = await db.query<{ id: number; name: string }>(
    `SELECT DISTINCT p.id, p.name
     FROM projects p
     JOIN project_ldap_groups plg ON plg.project_id = p.id
     WHERE p.id = $1 AND plg.ldap_group = ANY($2)`,
    [projectId, userGroups],
  );
  if (!rows[0]) { res.status(403).send('Access denied to this project'); return; }
  res.locals.project = rows[0];
  next();
}

router.use(requireProjectAccess);

// ── Helpers ───────────────────────────────────────────────────────

const adminGroup = () => process.env.ADMIN_GROUP ?? 'e4e-admin';

/** Returns the LDAP groups that belong to a given project */
async function projectGroups(projectId: number): Promise<string[]> {
  const { rows } = await db.query<{ ldap_group: string }>(
    `SELECT ldap_group FROM project_ldap_groups WHERE project_id = $1 ORDER BY ldap_group`,
    [projectId],
  );
  return rows.map((r) => r.ldap_group);
}

function triggerGithubInvite(githubUsername: string): void {
  const base = process.env.GITHUB_APP_URL ?? 'http://github-app:3001';
  fetch(`${base}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ githubUsername }),
  }).catch((err) => console.warn(`[pl] GitHub invite trigger failed for ${githubUsername}:`, err));
}

// ── User list ─────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const projectId = parseInt(req.params.projectId, 10);
  const groups = await projectGroups(projectId);

  if (groups.length === 0) {
    return res.render('pl/users/index', {
      project: res.locals.project,
      users: [],
      warning: 'This project has no LDAP groups — ask an admin to configure them.',
    });
  }

  const { rows: users } = await db.query(
    `SELECT username, first_name, last_name, email, role,
            TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            disabled, ldap_groups, github_username, slack_username
     FROM users
     WHERE ldap_groups && $1
     ORDER BY last_name, first_name`,
    [groups],
  );

  res.render('pl/users/index', { project: res.locals.project, users });
});

// ── Edit user ─────────────────────────────────────────────────────

router.get('/:username/edit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const projectId = parseInt(req.params.projectId, 10);

  const { rows } = await db.query(
    `SELECT username, first_name, last_name, email, role,
            TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            disabled, ldap_groups, github_username, slack_username
     FROM users WHERE username = $1`,
    [username],
  );
  if (!rows.length) return res.status(404).send('User not found');

  const user = rows[0] as { ldap_groups: string[]; [k: string]: unknown };

  // PLs cannot edit admin users
  if ((user.ldap_groups as string[]).includes(adminGroup())) {
    return res.status(403).send('Project leads cannot edit admin users.');
  }

  const projGroups = await projectGroups(projectId);

  res.render('pl/users/edit-user', {
    project: res.locals.project,
    user,
    projectGroups: projGroups,
  });
});

router.post('/:username/edit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const projectId = parseInt(req.params.projectId, 10);

  // Re-verify the user isn't an admin
  const { rows } = await db.query<{ ldap_groups: string[] }>(
    `SELECT ldap_groups FROM users WHERE username = $1`, [username],
  );
  if (!rows.length) return res.status(404).send('User not found');
  if (rows[0].ldap_groups.includes(adminGroup())) {
    return res.status(403).send('Project leads cannot edit admin users.');
  }

  const { expiryDate, githubUsername, slackUsername, disabled } = req.body as Record<string, string>;
  const selectedProjectGroups: string[] = [req.body.groups ?? []].flat();
  const projGroups = await projectGroups(projectId);

  // Merge: keep groups outside this project, apply changes to project groups only
  const nonProjectGroups = rows[0].ldap_groups.filter((g) => !projGroups.includes(g));
  const mergedGroups = [...new Set([...nonProjectGroups, ...selectedProjectGroups])];

  // Update groups in UDM
  const groupResult = await udm.updateUserGroups(username, mergedGroups);
  let udmError: string | null = null;
  if (groupResult.status === 'failed') {
    udmError = groupResult.message;
  } else {
    const expiryResult = await udm.updateUserExpiry(username, expiryDate ?? '');
    if (expiryResult.status === 'failed') udmError = expiryResult.message;
  }

  if (udmError) {
    const { rows: userRows } = await db.query(
      `SELECT username, first_name, last_name, email, role,
              TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
              disabled, ldap_groups, github_username, slack_username
       FROM users WHERE username = $1`,
      [username],
    );
    return res.render('pl/users/edit-user', {
      project: res.locals.project,
      user: userRows[0],
      projectGroups: projGroups,
      error: udmError,
    });
  }

  const cleanGithub = githubUsername?.trim() || null;
  const cleanSlack = slackUsername?.trim() || null;
  const isDisabled = disabled === 'true';

  await db.query(
    `UPDATE users SET
       expiry_date     = $1,
       ldap_groups     = $2,
       github_username = $3,
       slack_username  = $4,
       disabled        = $5,
       updated_at      = NOW()
     WHERE username = $6`,
    [expiryDate || null, mergedGroups, cleanGithub, cleanSlack, isDisabled, username],
  );

  // LDAP extended attribute write-back (non-fatal)
  const ldapFields: { slackId?: string | null; githubUsername?: string | null } = {};
  if (cleanSlack !== null) ldapFields.slackId = cleanSlack;
  if (cleanGithub !== null) ldapFields.githubUsername = cleanGithub;
  if (Object.keys(ldapFields).length > 0) {
    udm.updateUserLdapFields(username, ldapFields).catch((err) =>
      console.warn(`[pl] LDAP write-back failed for ${username}:`, err),
    );
  }

  if (cleanGithub) triggerGithubInvite(cleanGithub);

  res.redirect(`/pl/projects/${projectId}/users`);
});

// ── New user wizard ───────────────────────────────────────────────

router.get('/new', async (req: Request, res: Response) => {
  delete req.session.wizard;
  const projectId = parseInt(req.params.projectId, 10);
  const groups = await projectGroups(projectId);
  res.render('pl/users/new/step1', { project: res.locals.project, groups });
});

router.post('/new/sso', async (req: Request, res: Response) => {
  const projectId = parseInt(req.params.projectId, 10);
  const { firstName, lastName, email, expiryDate, ldapGroups } =
    req.body as Record<string, string | string[]>;

  const projGroups = await projectGroups(projectId);
  const cleanEmail = (email as string).trim().toLowerCase();
  const cleanFirst = (firstName as string).trim();
  const cleanLast = (lastName as string).trim();

  // Only allow groups within this project
  const chosenGroups = [ldapGroups ?? []].flat().filter((g) => projGroups.includes(g));

  const user: NewUser = {
    username: generateUsername(cleanFirst, cleanLast, cleanEmail),
    firstName: cleanFirst,
    lastName: cleanLast,
    email: cleanEmail,
    role: 'student', // PLs cannot set admin role
    expiryDate: expiryDate as string,
    ldapGroups: chosenGroups,
    githubTeams: [],
    serverGroups: [],
  };

  const result = await udm.createUser(user);

  if (result.status === 'success') {
    await db.query(
      `INSERT INTO users (username, first_name, last_name, email, role, expiry_date, ldap_groups, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()`,
      [user.username, user.firstName, user.lastName, user.email, user.role, user.expiryDate, user.ldapGroups],
    );
  }

  req.session.wizard = { user, steps: { sso: result } };

  res.render('pl/users/new/step1-result', {
    project: res.locals.project,
    user,
    result,
    nextUrl: `/pl/projects/${projectId}/users/new/github-slack`,
  });
});

router.get('/new/github-slack', (req: Request, res: Response) => {
  if (!req.session.wizard?.steps.sso) {
    return res.redirect(`/pl/projects/${req.params.projectId}/users/new`);
  }
  res.render('pl/users/new/step2', { project: res.locals.project, wizard: req.session.wizard });
});

router.post('/new/github-slack', async (req: Request, res: Response) => {
  const projectId = req.params.projectId;
  if (!req.session.wizard?.steps.sso) return res.redirect(`/pl/projects/${projectId}/users/new`);

  const { githubUsername, slackUsername } = req.body as Record<string, string>;
  const { username } = req.session.wizard.user;
  const cleanGithub = githubUsername?.trim() || null;
  const cleanSlack = slackUsername?.trim() || null;

  await db.query(
    `UPDATE users SET github_username = $1, slack_username = $2, updated_at = NOW() WHERE username = $3`,
    [cleanGithub, cleanSlack, username],
  );

  if (cleanGithub || cleanSlack) {
    const ldapFields: { slackId?: string | null; githubUsername?: string | null } = {};
    if (cleanSlack) ldapFields.slackId = cleanSlack;
    if (cleanGithub) ldapFields.githubUsername = cleanGithub;
    udm.updateUserLdapFields(username, ldapFields).catch((err) =>
      console.warn(`[pl-wizard] LDAP write-back failed for ${username}:`, err),
    );
  }

  if (cleanGithub) triggerGithubInvite(cleanGithub);

  res.redirect(`/pl/projects/${projectId}/users`);
});

// ── Audit log for a user ──────────────────────────────────────────

router.get('/:username/audit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const projectId = parseInt(req.params.projectId, 10);

  const { rows: [user] } = await db.query(
    `SELECT username, first_name, last_name, ldap_groups FROM users WHERE username = $1`,
    [username],
  );
  if (!user) return res.status(404).send('User not found');
  if ((user.ldap_groups as string[]).includes(adminGroup())) {
    return res.status(403).send('Access denied.');
  }

  const { rows: logs } = await db.query(
    `SELECT actor, action, details, created_at
     FROM audit_log WHERE target_username = $1 ORDER BY created_at DESC LIMIT 100`,
    [username],
  );

  res.render('pl/users/audit', { project: res.locals.project, user, logs });
});

export default router;
