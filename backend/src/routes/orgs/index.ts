import { Router, Request, Response } from 'express';
import { requireOrgMember } from '../../middleware/requireOrgMember';
import { requireOrgAdmin } from '../../middleware/requireOrgAdmin';
import { db, getOrgBySlug, upsertOrgGroupMapping } from '../../services/db';
import * as ldap from '../../services/ldap';
import { generateUsername } from '../../services/ldap';
import { NewUser } from '../../services/types';
import { ninetyDaysFromNow, triggerGithubInvite } from '../../utils/provisioning';

const router = Router({ mergeParams: true });

// ── Resolve org from slug, attach to res.locals ───────────────────

async function resolveOrg(req: Request, res: Response, next: Function): Promise<void> {
  const org = await getOrgBySlug(req.params.orgSlug);
  if (!org) { res.status(404).send('Organisation not found.'); return; }
  res.locals.org = org;
  next();
}

router.use(resolveOrg);

// ── Landing page — project list for org members ───────────────────

router.get('/', requireOrgMember, async (req: Request, res: Response) => {
  const org = res.locals.org;
  const { rows: projects } = await db.query(
    `SELECT id, name, description FROM projects WHERE org_id = $1 ORDER BY name`,
    [org.id],
  );
  res.render('orgs/landing', { org, projects, user: req.user });
});

// ── Admin: overview ───────────────────────────────────────────────

router.get('/admin', requireOrgAdmin, async (req: Request, res: Response) => {
  const org = res.locals.org;
  const [{ rows: projects }, { rows: mappings }] = await Promise.all([
    db.query(
      `SELECT p.id, p.name, p.description,
              COUNT(plg.ldap_group)::text AS group_count
       FROM projects p
       LEFT JOIN project_ldap_groups plg ON plg.project_id = p.id
       WHERE p.org_id = $1
       GROUP BY p.id ORDER BY p.name`,
      [org.id],
    ),
    db.query<{ ldap_group: string; role: string }>(
      `SELECT ldap_group, role FROM org_ldap_group_mappings WHERE org_id = $1 ORDER BY ldap_group`,
      [org.id],
    ),
  ]);
  res.render('orgs/admin/overview', { org, projects, mappings, user: req.user });
});

// ── Admin: create new LDAP group (auto-maps to this org) ─────────

router.post('/admin/groups', requireOrgAdmin, async (req: Request, res: Response) => {
  const org = res.locals.org;
  const { name, role } = req.body as { name?: string; role?: string };
  if (!name?.trim()) return res.status(400).send('Group name is required.');
  const validRoles = ['org_admin', 'project_lead', 'member'];
  const mappedRole = validRoles.includes(role ?? '') ? role! : 'member';

  const result = await ldap.createGroup(name.trim());
  if (result.status === 'failed') return res.status(500).send(`Failed to create LDAP group: ${result.message}`);

  await upsertOrgGroupMapping(org.id, name.trim(), mappedRole);
  res.redirect(`/orgs/${org.slug}/admin`);
});

// ── Admin: create project ─────────────────────────────────────────

router.post('/admin/projects', requireOrgAdmin, async (req: Request, res: Response) => {
  const org = res.locals.org;
  const { name, description } = req.body as Record<string, string>;
  if (!name?.trim()) return res.status(400).send('Project name is required.');
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO projects (name, description, org_id) VALUES ($1, $2, $3) RETURNING id`,
    [name.trim(), description?.trim() || null, org.id],
  );
  res.redirect(`/orgs/${org.slug}/admin/projects/${rows[0].id}`);
});

// ── Admin: project detail (group mappings) ────────────────────────

router.get('/admin/projects/:projectId', requireOrgAdmin, async (req: Request, res: Response) => {
  const org = res.locals.org;
  const { projectId } = req.params;

  const { rows: [project] } = await db.query(
    `SELECT id, name, description FROM projects WHERE id = $1 AND org_id = $2`,
    [projectId, org.id],
  );
  if (!project) return res.status(404).send('Project not found.');

  const { rows: mappedGroups } = await db.query<{ ldap_group: string }>(
    `SELECT ldap_group FROM project_ldap_groups WHERE project_id = $1 ORDER BY ldap_group`,
    [projectId],
  );

  // Org admins can only assign groups mapped to their org
  const { rows: orgMappings } = await db.query<{ ldap_group: string }>(
    `SELECT ldap_group FROM org_ldap_group_mappings WHERE org_id = $1 ORDER BY ldap_group`,
    [org.id],
  );

  const mapped = mappedGroups.map(r => r.ldap_group);
  const orgGroups = orgMappings.map(r => r.ldap_group);

  res.render('orgs/admin/project', { org, project, mapped, orgGroups, user: req.user });
});

// ── Admin: add/remove project group ──────────────────────────────

router.post('/admin/projects/:projectId/groups', requireOrgAdmin, async (req: Request, res: Response) => {
  const org = res.locals.org;
  const { projectId } = req.params;
  const { ldapGroup } = req.body as { ldapGroup: string };

  // Verify the group belongs to this org
  const { rows } = await db.query(
    `SELECT 1 FROM org_ldap_group_mappings WHERE org_id = $1 AND ldap_group = $2`,
    [org.id, ldapGroup],
  );
  if (!rows.length) return res.status(403).send('That group is not part of this organisation.');

  await db.query(
    `INSERT INTO project_ldap_groups (project_id, ldap_group) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [projectId, ldapGroup],
  );
  res.redirect(`/orgs/${org.slug}/admin/projects/${projectId}`);
});

router.post('/admin/projects/:projectId/groups/remove', requireOrgAdmin, async (req: Request, res: Response) => {
  const org = res.locals.org;
  const { projectId } = req.params;
  const { ldapGroup } = req.body as { ldapGroup: string };
  await db.query(
    `DELETE FROM project_ldap_groups WHERE project_id = $1 AND ldap_group = $2`,
    [projectId, ldapGroup],
  );
  res.redirect(`/orgs/${org.slug}/admin/projects/${projectId}`);
});

// ── Admin: project settings ───────────────────────────────────────

router.post('/admin/projects/:projectId/edit', requireOrgAdmin, async (req: Request, res: Response) => {
  const org = res.locals.org;
  const { projectId } = req.params;
  const { name, description } = req.body as Record<string, string>;
  if (!name?.trim()) return res.status(400).send('Project name is required.');
  await db.query(
    `UPDATE projects SET name = $1, description = $2, updated_at = NOW()
     WHERE id = $3 AND org_id = $4`,
    [name.trim(), description?.trim() || null, projectId, org.id],
  );
  res.redirect(`/orgs/${org.slug}/admin/projects/${projectId}`);
});

router.post('/admin/projects/:projectId/delete', requireOrgAdmin, async (req: Request, res: Response) => {
  const org = res.locals.org;
  const { projectId } = req.params;
  await db.query(`DELETE FROM projects WHERE id = $1 AND org_id = $2`, [projectId, org.id]);
  res.redirect(`/orgs/${org.slug}/admin`);
});

// ── Shared: fetch LDAP groups mapped to this org ─────────────────

async function orgGroups(orgId: number): Promise<string[]> {
  const { rows } = await db.query<{ ldap_group: string }>(
    `SELECT ldap_group FROM org_ldap_group_mappings WHERE org_id = $1 ORDER BY ldap_group`,
    [orgId],
  );
  return rows.map(r => r.ldap_group);
}

// ── Admin: members list ───────────────────────────────────────────

router.get('/admin/members', requireOrgAdmin, async (req: Request, res: Response) => {
  const org = res.locals.org;
  const groups = await orgGroups(org.id);

  const { rows: users } = groups.length
    ? await db.query(
        `SELECT username, first_name, last_name, email, role,
                TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
                disabled, ldap_groups
         FROM users WHERE ldap_groups && $1 ORDER BY last_name, first_name`,
        [groups],
      )
    : { rows: [] };

  res.render('orgs/admin/members', { org, users, orgGroups: groups, user: req.user });
});

// ── Admin: add existing user to org ──────────────────────────────

router.get('/admin/members/add', requireOrgAdmin, async (req: Request, res: Response) => {
  const org = res.locals.org;
  const query = (req.query.q as string)?.trim() || '';
  const groups = await orgGroups(org.id);

  if (!query) {
    return res.render('orgs/admin/members-add', { org, query, found: null, orgGroups: groups, user: req.user });
  }

  const { rows } = await db.query(
    `SELECT username, first_name, last_name, email, role, ldap_groups
     FROM users WHERE username ILIKE $1 OR email ILIKE $1 LIMIT 1`,
    [query],
  );

  res.render('orgs/admin/members-add', {
    org, query, found: rows[0] ?? null, orgGroups: groups, user: req.user,
  });
});

router.post('/admin/members/add', requireOrgAdmin, async (req: Request, res: Response) => {
  const org = res.locals.org;
  const { username } = req.body as Record<string, string>;
  const selectedGroups: string[] = [req.body.groups ?? []].flat();
  const groups = await orgGroups(org.id);

  const { rows } = await db.query<{ ldap_groups: string[] }>(
    `SELECT ldap_groups FROM users WHERE username = $1`, [username],
  );
  if (!rows.length) return res.status(404).send('User not found.');

  // Keep groups outside this org, merge in selected org groups
  const nonOrgGroups = rows[0].ldap_groups.filter(g => !groups.includes(g));
  const mergedGroups = [...new Set([...nonOrgGroups, ...selectedGroups])];

  const result = await ldap.updateUserGroups(username, mergedGroups);
  if (result.status === 'failed') return res.status(500).send(`Failed to update groups: ${result.message}`);

  await db.query(
    `UPDATE users SET ldap_groups = $1, updated_at = NOW() WHERE username = $2`,
    [mergedGroups, username],
  );

  res.redirect(`/orgs/${org.slug}/admin/members`);
});

// ── Admin: create new user ────────────────────────────────────────

router.get('/admin/members/new', requireOrgAdmin, async (req: Request, res: Response) => {
  const org = res.locals.org;
  const groups = await orgGroups(org.id);
  res.render('orgs/admin/members-new', { org, groups, expiryDate: ninetyDaysFromNow(), user: req.user });
});

router.post('/admin/members/new', requireOrgAdmin, async (req: Request, res: Response) => {
  const org = res.locals.org;
  const { firstName, lastName, email, secondaryEmail, phone, githubUsername, slackUsername, ldapGroups } =
    req.body as Record<string, string | string[]>;

  const groups = await orgGroups(org.id);
  const cleanFirst  = (firstName as string).trim();
  const cleanLast   = (lastName as string).trim();
  const cleanEmail  = (email as string).trim().toLowerCase();
  const cleanSecondary = (secondaryEmail as string)?.trim().toLowerCase() || null;
  const cleanPhone  = (phone as string)?.trim() || null;
  const cleanGithub = (githubUsername as string)?.trim() || null;
  const cleanSlack  = (slackUsername as string)?.trim() || null;

  const chosenGroups = [ldapGroups ?? []].flat().filter(g => groups.includes(g));

  const user: NewUser = {
    username: generateUsername(cleanFirst, cleanLast, cleanEmail),
    firstName: cleanFirst,
    lastName: cleanLast,
    email: cleanEmail,
    role: 'student',
    expiryDate: ninetyDaysFromNow(),
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
    if (cleanGithub) triggerGithubInvite(cleanGithub);
  }

  res.render('orgs/admin/members-new-result', { org, user, ldapResult, tempPassword: ldapResult.tempPassword });
});

export default router;
