import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../services/db';
import * as ldap from '../../services/ldap';
import { generateUsername } from '../../services/ldap';
import { triggerGithubInvite } from '../../services/integrations';
import { ensureUserOrgMembership } from '../../services/db';
import { NewUser } from '../../services/types';

const router = Router({ mergeParams: true });

// ── Guard: PL must belong to this project ─────────────────────────
async function requireProjectAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).send('Invalid project ID'); return; }

  const orgId = res.locals.currentOrg?.id;
  if (!orgId) { res.status(400).send('No organisation context'); return; }
  const isAdmin = req.user && (req.user.isSystemAdmin || req.user.isLocalAdmin ||
    res.locals.currentOrgMembership?.role === 'org_admin');

  if (isAdmin) {
    const { rows } = await db.query<{ id: number; name: string }>(
      'SELECT id, name FROM projects WHERE id = $1 AND org_id = $2', [projectId, orgId],
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
     WHERE p.id = $1 AND p.org_id = $2 AND plg.ldap_group = ANY($3)`,
    [projectId, orgId, userGroups],
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

function groupsFromRequest(value: unknown): string[] {
  return [value ?? []].flat().filter((group): group is string => typeof group === 'string');
}

function hasOnlyProjectGroups(selectedGroups: string[], projectGroups: string[]): boolean {
  const allowed = new Set(projectGroups);
  return selectedGroups.every((group) => allowed.has(group));
}

async function getProjectMember(
  username: string,
  projectId: number,
  orgId: number,
): Promise<Record<string, unknown> | null> {
  const { rows } = await db.query(
    `SELECT u.username, u.first_name, u.last_name, u.email, u.secondary_email, u.phone, u.role,
            TO_CHAR(u.expiry_date, 'YYYY-MM-DD') AS expiry_date,
            u.disabled, u.ldap_groups, u.github_username, u.slack_username
     FROM users u
     JOIN user_orgs uo ON uo.username = u.username AND uo.org_id = $3
     WHERE u.username = $1
       AND EXISTS (
         SELECT 1 FROM project_ldap_groups plg
         WHERE plg.project_id = $2 AND plg.ldap_group = ANY(u.ldap_groups)
       )`,
    [username, projectId, orgId],
  );
  return rows[0] ?? null;
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
  const orgId = res.locals.currentOrg?.id as number;
  const groups = await projectGroups(projectId);
  if (groups.length === 0) {
    return res.render('pl/users/index', {
      project: res.locals.project, users: [],
      warning: 'This project has no LDAP groups — ask an admin to configure them.',
    });
  }
  const { rows: users } = await db.query(
    `SELECT u.username, u.first_name, u.last_name, u.email, u.role,
            TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            u.disabled, u.ldap_groups, u.github_username, u.slack_username
     FROM users u
     JOIN user_orgs uo ON uo.username = u.username AND uo.org_id = $2
     WHERE u.ldap_groups && $1 ORDER BY u.last_name, u.first_name`,
    [groups, orgId],
  );
  res.render('pl/users/index', { project: res.locals.project, users });
});

// ── Edit user ─────────────────────────────────────────────────────
router.get('/:username/edit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const projectId = parseInt(req.params.projectId, 10);
  const orgId = res.locals.currentOrg?.id as number;
  const member = await getProjectMember(username, projectId, orgId);
  if (!member) return res.status(404).send('Project member not found');
  const user = member as { ldap_groups: string[]; [k: string]: unknown };
  if (user.ldap_groups.includes(adminGroup())) {
    return res.status(403).send('Project leads cannot edit admin users.');
  }
  const ldapUser = await ldap.getUser(username).catch(() => null);
  res.render('pl/users/edit-user', {
    project: res.locals.project,
    user,
    projectGroups: await projectGroups(projectId),
    sshPublicKeys: ldapUser?.sshPublicKeys ?? [],
  });
});

router.post('/:username/edit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const projectId = parseInt(req.params.projectId, 10);
  const orgId = res.locals.currentOrg?.id as number;
  const member = await getProjectMember(username, projectId, orgId) as { ldap_groups: string[] } | null;
  if (!member) return res.status(404).send('Project member not found');
  if (member.ldap_groups.includes(adminGroup())) {
    return res.status(403).send('Project leads cannot edit admin users.');
  }

  const { githubUsername, slackUsername, secondaryEmail, phone, disabled, sshKeys } =
    req.body as Record<string, string>;
  const selectedProjectGroups = groupsFromRequest(req.body.groups);
  const sshPublicKeys = (sshKeys || '').split('\n').map((k: string) => k.trim()).filter(Boolean);
  const projGroups = await projectGroups(projectId);
  if (!hasOnlyProjectGroups(selectedProjectGroups, projGroups)) {
    return res.status(400).send('Submitted groups do not belong to this project.');
  }
  const nonProjectGroups = member.ldap_groups.filter((g) => !projGroups.includes(g));
  const mergedGroups = [...new Set([...nonProjectGroups, ...selectedProjectGroups])];

  const [groupResult, sshResult] = await Promise.all([
    ldap.updateUserGroups(username, mergedGroups),
    ldap.setSshKeys(username, sshPublicKeys),
  ]);

  const ldapError = [groupResult, sshResult].find(r => r.status === 'failed')?.message ?? null;

  if (ldapError) {
    const { rows: userRows } = await db.query(
      `SELECT username, first_name, last_name, email, secondary_email, phone, role,
              TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
              disabled, ldap_groups, github_username, slack_username
       FROM users WHERE username = $1`,
      [username],
    );
    return res.render('pl/users/edit-user', {
      project: res.locals.project,
      user: userRows[0],
      projectGroups: projGroups,
      sshPublicKeys,
      error: ldapError,
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

  if (cleanGithub) triggerGithubInvite(cleanGithub, res.locals.currentOrg?.id as number | undefined);

  await db.query(
    `INSERT INTO audit_log (actor, action, target_username, details, org_id)
     VALUES ($1, 'pl_edit_user', $2, $3, $4)`,
    [req.user?.username, username, JSON.stringify({ projectId, groups: mergedGroups, sshKeyCount: sshPublicKeys.length }), res.locals.currentOrg?.id ?? null],
  );

  res.redirect(plBase(res, projectId));
});

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
});

router.post('/add', async (req: Request, res: Response) => {
  const projectId = parseInt(req.params.projectId, 10);
  const { username } = req.body as Record<string, string>;
  const selectedProjectGroups = groupsFromRequest(req.body.groups);
  const projGroups = await projectGroups(projectId);
  if (!hasOnlyProjectGroups(selectedProjectGroups, projGroups) || selectedProjectGroups.length === 0) {
    return res.status(400).send('Choose at least one group belonging to this project.');
  }

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
  await ensureUserOrgMembership(username, res.locals.currentOrg?.id as number);

  await db.query(
    `INSERT INTO audit_log (actor, action, target_username, details, org_id)
     VALUES ($1, 'pl_add_to_project', $2, $3, $4)`,
    [req.user?.username, username, JSON.stringify({ projectId, groups: mergedGroups }), res.locals.currentOrg?.id ?? null],
  );

  res.redirect(plBase(res, projectId));
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
  const selectedProjectGroups = groupsFromRequest(ldapGroups);
  if (!hasOnlyProjectGroups(selectedProjectGroups, projGroups) || selectedProjectGroups.length === 0) {
    return res.status(400).send('Choose at least one group belonging to this project.');
  }
  const chosenGroups = selectedProjectGroups;

  const user: NewUser = {
    username: generateUsername(cleanFirst, cleanLast, cleanEmail),
    firstName: cleanFirst,
    lastName: cleanLast,
    email: cleanEmail,
    role: 'student',
    expiryDate,
    ldapGroups: chosenGroups,
    sshPublicKeys: [],
    githubTeams: [],
    serverGroups: [],
  };

  const ldapResult = await ldap.createUser(user);

  if (ldapResult.status !== 'failed') {
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
    await ensureUserOrgMembership(user.username, res.locals.currentOrg?.id as number);
    if (cleanGithub) triggerGithubInvite(cleanGithub, res.locals.currentOrg?.id as number | undefined);
  }

  await db.query(
    `INSERT INTO audit_log (actor, action, target_username, details, org_id)
     VALUES ($1, 'pl_create_user', $2, $3, $4)`,
    [req.user?.username, user.username, JSON.stringify({ projectId, ldapStatus: ldapResult.status, email: user.email }), res.locals.currentOrg?.id ?? null],
  );

  res.render('pl/users/new-result', {
    project: res.locals.project,
    user,
    ldapResult,
    tempPassword: ldapResult.tempPassword,
  });
});

// ── Audit log ────────────────────────────────────────────────────
router.get('/:username/audit', async (req: Request, res: Response) => {
  const { username } = req.params;
  const projectId = parseInt(req.params.projectId, 10);
  const orgId = res.locals.currentOrg?.id as number;
  const user = await getProjectMember(username, projectId, orgId);
  if (!user) return res.status(404).send('Project member not found');
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
