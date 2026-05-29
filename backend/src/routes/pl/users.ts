import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../services/db';
import * as ldap from '../../services/ldap';
import { generateUsername } from '../../services/ldap';
import { triggerGithubInvite } from '../../services/integrations';
import { isAnyOrgAdmin } from '../../types/user';
import { NewUser } from '../../services/types';

const router = Router({ mergeParams: true });

// ── Guard: PL must belong to this project ─────────────────────────
async function requireProjectAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).send('Invalid project ID'); return; }

  const isAdmin = req.user && (req.user.isSystemAdmin || isAnyOrgAdmin(req.user));

  if (isAdmin) {
    const { rows } = await db.query<{ id: number; name: string }>(
      'SELECT id, name FROM projects WHERE id = $1', [projectId],
    );
    if (!rows[0]) { res.status(404).send('Project not found'); return; }
    res.locals.project = rows[0];
    return next();
  }

  const userGroups: string[] = req.user?.groups ?? [];
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
async function projectGroups(projectId: number): Promise<string[]> {
  const { rows } = await db.query<{ ldap_group: string }>(
    'SELECT ldap_group FROM project_ldap_groups WHERE project_id = $1 ORDER BY ldap_group',
    [projectId],
  );
  return rows.map((r) => r.ldap_group);
}

function ninetyDaysFromNow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 90);
  return d.toISOString().slice(0, 10);
}

const adminGroup = () => process.env.ADMIN_GROUP ?? 'e4e-admin';
const plBase     = (res: Response, projectId: number | string) =>
  `${res.locals.orgBase}/pl/projects/${projectId}/users`;

// ── User list ─────────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response) => {
  const projectId = parseInt(req.params.projectId, 10);
  const groups = await projectGroups(projectId);
  if (groups.length === 0) {
    return res.render('pl/users/index', {
      project: res.locals.project, users: [],
      warning: 'This project has no LDAP groups — ask an admin to configure them.',
    });
  }
  const { rows: users } = await db.query(
    `SELECT username, first_name, last_name, email, role,
            TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            disabled, ldap_groups, github_username, slack_username
     FROM users WHERE ldap_groups && $1 ORDER BY last_name, first_name`,
    [groups],
  );
  res.render('pl/users/index', { project: res.locals.project, users });
});

// ── Edit user ─────────────────────────────────────────────────────
router.get('/:username/edit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const projectId = parseInt(req.params.projectId, 10);
  const { rows } = await db.query(
    `SELECT username, first_name, last_name, email, secondary_email, phone, role,
            TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            disabled, ldap_groups, github_username, slack_username
     FROM users WHERE username = $1`,
    [username],
  );
  if (!rows.length) return res.status(404).send('User not found');
  const user = rows[0] as { ldap_groups: string[]; [k: string]: unknown };
  if (user.ldap_groups.includes(adminGroup())) {
    return res.status(403).send('Project leads cannot edit admin users.');
  }
  res.render('pl/users/edit-user', {
    project: res.locals.project,
    user,
    projectGroups: await projectGroups(projectId),
  });
});

router.post('/:username/edit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const projectId = parseInt(req.params.projectId, 10);
  const { rows } = await db.query<{ ldap_groups: string[] }>(
    'SELECT ldap_groups FROM users WHERE username = $1', [username],
  );
  if (!rows.length) return res.status(404).send('User not found');
  if (rows[0].ldap_groups.includes(adminGroup())) {
    return res.status(403).send('Project leads cannot edit admin users.');
  }

  const { githubUsername, slackUsername, secondaryEmail, phone, disabled } =
    req.body as Record<string, string>;
  const selectedProjectGroups: string[] = [req.body.groups ?? []].flat();
  const projGroups = await projectGroups(projectId);
  const nonProjectGroups = rows[0].ldap_groups.filter((g) => !projGroups.includes(g));
  const mergedGroups = [...new Set([...nonProjectGroups, ...selectedProjectGroups])];

<<<<<<< HEAD
  const groupResult = await udm.updateUserGroups(username, mergedGroups);
=======
  const groupResult = await ldap.updateUserGroups(username, mergedGroups);

>>>>>>> main
  if (groupResult.status === 'failed') {
    const { rows: userRows } = await db.query(
      `SELECT username, first_name, last_name, email, secondary_email, phone, role,
              TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
              disabled, ldap_groups, github_username, slack_username
       FROM users WHERE username = $1`,
      [username],
    );
    return res.render('pl/users/edit-user', {
<<<<<<< HEAD
      project: res.locals.project, user: userRows[0],
      projectGroups: projGroups, error: groupResult.message,
=======
      project: res.locals.project,
      user: userRows[0],
      projectGroups: projGroups,
      error: groupResult.message,
>>>>>>> main
    });
  }

  const cleanGithub    = githubUsername?.trim()  || null;
  const cleanSlack     = slackUsername?.trim()   || null;
  const cleanSecondary = secondaryEmail?.trim().toLowerCase() || null;
  const cleanPhone     = phone?.trim() || null;

  await db.query(
    `UPDATE users SET ldap_groups=$1, github_username=$2, slack_username=$3,
       secondary_email=$4, phone=$5, disabled=$6, updated_at=NOW()
     WHERE username=$7`,
    [mergedGroups, cleanGithub, cleanSlack, cleanSecondary, cleanPhone, disabled === 'true', username],
  );

<<<<<<< HEAD
  udm.updateUserLdapFields(username, {
    ...(cleanSlack  !== null && { slackId: cleanSlack }),
    ...(cleanGithub !== null && { githubUsername: cleanGithub }),
    secondaryEmail: cleanSecondary, phone: cleanPhone,
  }).catch((err) => console.warn(`[pl] LDAP write-back failed for ${username}:`, err));
=======
  // TODO: write slack/github/secondaryEmail/phone back to LDAP once extended attribute strategy is decided
>>>>>>> main

  if (cleanGithub) triggerGithubInvite(cleanGithub, res.locals.currentOrg?.id as number | undefined, 'pl');

  res.redirect(plBase(res, projectId));
});

// ── New user wizard ───────────────────────────────────────────────
<<<<<<< HEAD
router.get('/new', async (req: Request, res: Response) => {
  delete req.session.wizard;
  const projectId = parseInt(req.params.projectId, 10);
  res.render('pl/users/new/step1', {
    project: res.locals.project,
    groups: await projectGroups(projectId),
  });
=======

// ── Add existing user to project ─────────────────────────────────

router.get('/add', async (req: Request, res: Response) => {
  const projectId = parseInt(req.params.projectId, 10);
  const query = (req.query.q as string)?.trim() || '';
  const projGroups = await projectGroups(projectId);

  if (!query) {
    return res.render('pl/users/add', { project: res.locals.project, query, found: null, projGroups });
  }

  const { rows } = await db.query(
    `SELECT username, first_name, last_name, email, role, ldap_groups
     FROM users
     WHERE username ILIKE $1 OR email ILIKE $1
     LIMIT 1`,
    [query],
  );

  const found = rows[0] ?? null;
  if (found && (found.ldap_groups as string[]).includes(adminGroup())) {
    return res.render('pl/users/add', {
      project: res.locals.project, query, found: null, projGroups,
      error: 'That user is an admin and cannot be managed via the project portal.',
    });
  }

  res.render('pl/users/add', { project: res.locals.project, query, found, projGroups });
>>>>>>> main
});

router.post('/add', async (req: Request, res: Response) => {
  const projectId = parseInt(req.params.projectId, 10);
  const { username } = req.body as Record<string, string>;
  const selectedProjectGroups: string[] = [req.body.groups ?? []].flat();
  const projGroups = await projectGroups(projectId);

  const { rows } = await db.query<{ ldap_groups: string[] }>(
    `SELECT ldap_groups FROM users WHERE username = $1`, [username],
  );
  if (!rows.length) return res.status(404).send('User not found');
  if (rows[0].ldap_groups.includes(adminGroup())) return res.status(403).send('Access denied.');

  // Merge: keep groups outside this project, apply chosen project groups
  const nonProjectGroups = rows[0].ldap_groups.filter((g) => !projGroups.includes(g));
  const mergedGroups = [...new Set([...nonProjectGroups, ...selectedProjectGroups])];

  const result = await ldap.updateUserGroups(username, mergedGroups);
  if (result.status === 'failed') {
    return res.status(500).send(`Failed to update groups: ${result.message}`);
  }

  await db.query(
    `UPDATE users SET ldap_groups = $1, updated_at = NOW() WHERE username = $2`,
    [mergedGroups, username],
  );

  res.redirect(`/pl/projects/${projectId}/users`);
});

// ── New user ──────────────────────────────────────────────────────

router.get('/new', async (req: Request, res: Response) => {
  const projectId = parseInt(req.params.projectId, 10);
  const groups = await projectGroups(projectId);
  const expiryDate = ninetyDaysFromNow();
  res.render('pl/users/new', { project: res.locals.project, groups, expiryDate });
});

router.post('/new', async (req: Request, res: Response) => {
  const projectId = parseInt(req.params.projectId, 10);
  const { firstName, lastName, email, secondaryEmail, phone, githubUsername, slackUsername, ldapGroups } =
    req.body as Record<string, string | string[]>;

<<<<<<< HEAD
  const cleanEmail     = (email as string).trim().toLowerCase();
  const cleanFirst     = (firstName as string).trim();
  const cleanLast      = (lastName as string).trim();
  const cleanSecondary = (secondaryEmail as string)?.trim().toLowerCase() || null;
  const cleanPhone     = (phone as string)?.trim() || null;

  const projGroups  = await projectGroups(projectId);
  const chosenGroups = [ldapGroups ?? []].flat().filter((g) => projGroups.includes(g));

  const user: NewUser = {
    username:    generateUsername(cleanFirst, cleanLast, cleanEmail),
    firstName:   cleanFirst,
    lastName:    cleanLast,
    email:       cleanEmail,
    role:        'student',
    expiryDate:  ninetyDaysFromNow(),  // enforced server-side
    ldapGroups:  chosenGroups,
=======
  const projGroups = await projectGroups(projectId);
  const cleanFirst = (firstName as string).trim();
  const cleanLast = (lastName as string).trim();
  const cleanEmail = (email as string).trim().toLowerCase();
  const cleanSecondary = (secondaryEmail as string)?.trim().toLowerCase() || null;
  const cleanPhone = (phone as string)?.trim() || null;
  const cleanGithub = (githubUsername as string)?.trim() || null;
  const cleanSlack = (slackUsername as string)?.trim() || null;

  // Enforce 90-day expiry and student role server-side — PLs cannot change these
  const expiryDate = ninetyDaysFromNow();
  // Only allow groups belonging to this project
  const chosenGroups = [ldapGroups ?? []].flat().filter((g) => projGroups.includes(g));

  const user: NewUser = {
    username: generateUsername(cleanFirst, cleanLast, cleanEmail),
    firstName: cleanFirst,
    lastName: cleanLast,
    email: cleanEmail,
    role: 'student',
    expiryDate,
    ldapGroups: chosenGroups,
    sshPublicKeys: [],
>>>>>>> main
    githubTeams: [],
    serverGroups: [],
  };

<<<<<<< HEAD
  const result = await udm.createUser(user);
  if (result.status === 'success') {
=======
  const ldapResult = await ldap.createUser(user);

  if (ldapResult.status !== 'failed') {
>>>>>>> main
    await db.query(
      `INSERT INTO users
         (username, first_name, last_name, email, secondary_email, phone, role,
          expiry_date, ldap_groups, github_username, slack_username, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (username) DO UPDATE SET
         github_username = COALESCE(EXCLUDED.github_username, users.github_username),
         slack_username  = COALESCE(EXCLUDED.slack_username,  users.slack_username),
         updated_at      = NOW()`,
      [user.username, user.firstName, user.lastName, user.email,
       cleanSecondary, cleanPhone, user.role, user.expiryDate, user.ldapGroups,
       cleanGithub, cleanSlack],
    );
    if (cleanGithub) triggerGithubInvite(cleanGithub);
  }

<<<<<<< HEAD
  req.session.wizard = { user, steps: { sso: result } };
  res.render('pl/users/new/step1-result', {
    project: res.locals.project, user, result,
    nextUrl: `${plBase(res, projectId)}/new/github-slack`,
  });
});

router.get('/new/github-slack', (req: Request, res: Response) => {
  if (!req.session.wizard?.steps.sso) {
    return res.redirect(`${plBase(res, req.params.projectId)}/new`);
  }
  res.render('pl/users/new/step2', { project: res.locals.project, wizard: req.session.wizard });
});

router.post('/new/github-slack', async (req: Request, res: Response) => {
  const { projectId } = req.params;
  if (!req.session.wizard?.steps.sso) {
    return res.redirect(`${plBase(res, projectId)}/new`);
  }

  const { githubUsername, slackUsername } = req.body as Record<string, string>;
  const { username } = req.session.wizard.user;
  const cleanGithub = githubUsername?.trim() || null;
  const cleanSlack  = slackUsername?.trim()  || null;

  await db.query(
    'UPDATE users SET github_username=$1, slack_username=$2, updated_at=NOW() WHERE username=$3',
    [cleanGithub, cleanSlack, username],
  );

  if (cleanGithub || cleanSlack) {
    udm.updateUserLdapFields(username, {
      ...(cleanSlack  && { slackId: cleanSlack }),
      ...(cleanGithub && { githubUsername: cleanGithub }),
    }).catch((err) => console.warn(`[pl-wizard] LDAP write-back failed for ${username}:`, err));
  }

  if (cleanGithub) triggerGithubInvite(cleanGithub, res.locals.currentOrg?.id as number | undefined, 'pl-wizard');

  res.redirect(plBase(res, projectId));
});

// ── Audit log ─────────────────────────────────────────────────────
=======
  res.render('pl/users/new-result', {
    project: res.locals.project,
    user,
    ldapResult,
    tempPassword: ldapResult.tempPassword,
  });
});

// ── Audit log for a user ──────────────────────────────────────────

>>>>>>> main
router.get('/:username/audit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const { rows: [user] } = await db.query(
    'SELECT username, first_name, last_name, ldap_groups FROM users WHERE username = $1',
    [username],
  );
  if (!user) return res.status(404).send('User not found');
  if ((user.ldap_groups as string[]).includes(adminGroup())) {
    return res.status(403).send('Access denied.');
  }
  const { rows: logs } = await db.query(
    'SELECT actor, action, details, created_at FROM audit_log WHERE target_username = $1 ORDER BY created_at DESC LIMIT 100',
    [username],
  );
  res.render('pl/users/audit', { project: res.locals.project, user, logs });
});

export default router;
