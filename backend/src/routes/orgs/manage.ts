import { Router, Request, Response, NextFunction } from 'express';
import { db, getProjectGroups } from '../../services/db';
import * as ldap from '../../services/ldap';
import { generateUsername } from '../../services/ldap';
import { NewUser } from '../../services/types';
import { ninetyDaysFromNow, triggerGithubInvite } from '../../utils/provisioning';

const router = Router({ mergeParams: true });

// ── Guard: project must belong to this org, user must have access ─

async function requireProjectAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  const org = res.locals.org;
  const projectId = parseInt(req.params.projectId, 10);
  if (isNaN(projectId)) { res.status(400).send('Invalid project ID'); return; }

  const { rows: [project] } = await db.query<{ id: number; name: string }>(
    `SELECT id, name FROM projects WHERE id = $1 AND org_id = $2`,
    [projectId, org.id],
  );
  if (!project) { res.status(404).send('Project not found'); return; }
  res.locals.project = project;

  if (req.user?.isSystemAdmin) return next();
  const orgRole = req.user?.orgRoles?.find(r => r.orgSlug === org.slug);
  if (orgRole?.role === 'org_admin') return next();

  const userGroups = req.user?.groups ?? [];
  const { rows } = await db.query(
    `SELECT 1 FROM project_ldap_groups WHERE project_id = $1 AND ldap_group = ANY($2) LIMIT 1`,
    [projectId, userGroups],
  );
  if (rows.length) return next();

  res.status(403).send('Access denied to this project.');
}

router.use(requireProjectAccess);

const adminGroup = () => process.env.ADMIN_GROUP ?? 'e4e-admin';

// ── Member list ───────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const { project, org } = res.locals;
  const groups = await getProjectGroups(project.id);

  if (!groups.length) {
    return res.render('orgs/manage/index', {
      org, project, users: [],
      warning: 'This project has no LDAP groups — ask an org admin to configure them.',
    });
  }

  const { rows: users } = await db.query(
    `SELECT username, first_name, last_name, email, role,
            TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            disabled, ldap_groups, github_username, slack_username
     FROM users WHERE ldap_groups && $1 ORDER BY last_name, first_name`,
    [groups],
  );

  res.render('orgs/manage/index', { org, project, users });
});

// ── Add existing user ─────────────────────────────────────────────

router.get('/add', async (req: Request, res: Response) => {
  const { project, org } = res.locals;
  const query = (req.query.q as string)?.trim() || '';
  const projGroups = await getProjectGroups(project.id);

  if (!query) {
    return res.render('orgs/manage/add', { org, project, query, found: null, projGroups });
  }

  const { rows } = await db.query(
    `SELECT username, first_name, last_name, email, role, ldap_groups
     FROM users WHERE username ILIKE $1 OR email ILIKE $1 LIMIT 1`,
    [query],
  );

  const found = rows[0] ?? null;
  if (found && (found.ldap_groups as string[]).includes(adminGroup())) {
    return res.render('orgs/manage/add', {
      org, project, query, found: null, projGroups,
      error: 'That user is an admin and cannot be managed via the project portal.',
    });
  }

  res.render('orgs/manage/add', { org, project, query, found, projGroups });
});

router.post('/add', async (req: Request, res: Response) => {
  const { project, org } = res.locals;
  const { username } = req.body as Record<string, string>;
  const selectedGroups: string[] = [req.body.groups ?? []].flat();
  const projGroups = await getProjectGroups(project.id);

  const { rows } = await db.query<{ ldap_groups: string[] }>(
    `SELECT ldap_groups FROM users WHERE username = $1`, [username],
  );
  if (!rows.length) return res.status(404).send('User not found.');
  if (rows[0].ldap_groups.includes(adminGroup())) return res.status(403).send('Access denied.');

  const nonProjectGroups = rows[0].ldap_groups.filter(g => !projGroups.includes(g));
  const mergedGroups = [...new Set([...nonProjectGroups, ...selectedGroups])];

  const result = await ldap.updateUserGroups(username, mergedGroups);
  if (result.status === 'failed') return res.status(500).send(`Failed to update groups: ${result.message}`);

  await db.query(
    `UPDATE users SET ldap_groups = $1, updated_at = NOW() WHERE username = $2`,
    [mergedGroups, username],
  );

  res.redirect(`/orgs/${org.slug}/projects/${project.id}/manage`);
});

// ── New user ──────────────────────────────────────────────────────

router.get('/new', async (_req: Request, res: Response) => {
  const { project, org } = res.locals;
  const groups = await getProjectGroups(project.id);
  res.render('orgs/manage/new', { org, project, groups, expiryDate: ninetyDaysFromNow() });
});

router.post('/new', async (req: Request, res: Response) => {
  const { project, org } = res.locals;
  const { firstName, lastName, email, secondaryEmail, phone, githubUsername, slackUsername, ldapGroups, sshKeys } =
    req.body as Record<string, string | string[]>;

  const projGroups = await getProjectGroups(project.id);
  const cleanFirst     = (firstName as string).trim();
  const cleanLast      = (lastName as string).trim();
  const cleanEmail     = (email as string).trim().toLowerCase();
  const cleanSecondary = (secondaryEmail as string)?.trim().toLowerCase() || null;
  const cleanPhone     = (phone as string)?.trim() || null;
  const cleanGithub    = (githubUsername as string)?.trim() || null;
  const cleanSlack     = (slackUsername as string)?.trim() || null;
  const sshPublicKeys  = ((sshKeys as string) || '').split('\n').map(k => k.trim()).filter(Boolean);

  const chosenGroups = [ldapGroups ?? []].flat().filter(g => projGroups.includes(g));

  const user: NewUser = {
    username: generateUsername(cleanFirst, cleanLast, cleanEmail),
    firstName: cleanFirst,
    lastName: cleanLast,
    email: cleanEmail,
    role: 'student',
    expiryDate: ninetyDaysFromNow(),
    ldapGroups: chosenGroups,
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

  res.render('orgs/manage/new-result', { org, project, user, ldapResult, sshResults, tempPassword: ldapResult.tempPassword });
});

// ── Edit user ─────────────────────────────────────────────────────

router.get('/:username/edit', async (req: Request, res: Response) => {
  const { project, org } = res.locals;
  const { username } = req.params;

  const { rows } = await db.query(
    `SELECT username, first_name, last_name, email, secondary_email, phone, role,
            TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
            disabled, ldap_groups, github_username, slack_username
     FROM users WHERE username = $1`,
    [username],
  );
  if (!rows.length) return res.status(404).send('User not found.');
  if ((rows[0].ldap_groups as string[]).includes(adminGroup())) {
    return res.status(403).send('Project leads cannot edit admin users.');
  }

  const projGroups = await getProjectGroups(project.id);
  res.render('orgs/manage/edit-user', { org, project, user: rows[0], projectGroups: projGroups });
});

router.post('/:username/edit', async (req: Request, res: Response) => {
  const { project, org } = res.locals;
  const { username } = req.params;

  const { rows } = await db.query<{ ldap_groups: string[] }>(
    `SELECT ldap_groups FROM users WHERE username = $1`, [username],
  );
  if (!rows.length) return res.status(404).send('User not found.');
  if (rows[0].ldap_groups.includes(adminGroup())) {
    return res.status(403).send('Project leads cannot edit admin users.');
  }

  const { githubUsername, slackUsername, secondaryEmail, phone, disabled } =
    req.body as Record<string, string>;
  const selectedProjectGroups: string[] = [req.body.groups ?? []].flat();
  const projGroups = await getProjectGroups(project.id);

  const nonProjectGroups = rows[0].ldap_groups.filter(g => !projGroups.includes(g));
  const mergedGroups = [...new Set([...nonProjectGroups, ...selectedProjectGroups])];

  const groupResult = await ldap.updateUserGroups(username, mergedGroups);

  if (groupResult.status === 'failed') {
    const { rows: userRows } = await db.query(
      `SELECT username, first_name, last_name, email, secondary_email, phone, role,
              TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
              disabled, ldap_groups, github_username, slack_username
       FROM users WHERE username = $1`,
      [username],
    );
    return res.render('orgs/manage/edit-user', {
      org, project, user: userRows[0], projectGroups: projGroups, error: groupResult.message,
    });
  }

  const cleanGithub    = githubUsername?.trim() || null;
  const cleanSlack     = slackUsername?.trim() || null;
  const cleanSecondary = secondaryEmail?.trim().toLowerCase() || null;
  const cleanPhone     = phone?.trim() || null;
  const isDisabled     = disabled === 'true';

  await db.query(
    `UPDATE users SET
       ldap_groups     = $1,
       github_username = $2,
       slack_username  = $3,
       secondary_email = $4,
       phone           = $5,
       disabled        = $6,
       updated_at      = NOW()
     WHERE username = $7`,
    [mergedGroups, cleanGithub, cleanSlack, cleanSecondary, cleanPhone, isDisabled, username],
  );

  if (cleanGithub) triggerGithubInvite(cleanGithub);

  res.redirect(`/orgs/${org.slug}/projects/${project.id}/manage`);
});

// ── Audit log ─────────────────────────────────────────────────────

router.get('/:username/audit', async (req: Request, res: Response) => {
  const { project, org } = res.locals;
  const { username } = req.params;

  const { rows: [user] } = await db.query(
    `SELECT username, first_name, last_name, ldap_groups FROM users WHERE username = $1`,
    [username],
  );
  if (!user) return res.status(404).send('User not found.');
  if ((user.ldap_groups as string[]).includes(adminGroup())) return res.status(403).send('Access denied.');

  const { rows: logs } = await db.query(
    `SELECT actor, action, details, created_at
     FROM audit_log WHERE target_username = $1 ORDER BY created_at DESC LIMIT 100`,
    [username],
  );

  res.render('orgs/manage/audit', { org, project, user, logs });
});

export default router;
