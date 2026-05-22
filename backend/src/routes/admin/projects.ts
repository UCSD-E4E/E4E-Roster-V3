import { Router, Request, Response } from 'express';
import { db, upsertOrgGroupMapping, getAllOrgs } from '../../services/db';
import { listGroups } from '../../services/ldap';

const router = Router();
// requireAdmin is applied at the admin/index.ts level

// ── Project list ──────────────────────────────────────────────────

router.get('/', async (_req: Request, res: Response) => {
  const { rows: projects } = await db.query<{ id: number; name: string; description: string | null; group_count: string }>(
    `SELECT p.id, p.name, p.description, COUNT(plg.ldap_group)::text AS group_count
     FROM projects p
     LEFT JOIN project_ldap_groups plg ON plg.project_id = p.id
     GROUP BY p.id ORDER BY p.name`,
  );
  res.render('admin/projects/index', { projects });
});

// ── Create project ────────────────────────────────────────────────

router.post('/', async (req: Request, res: Response) => {
  const { name, description } = req.body as Record<string, string>;
  if (!name?.trim()) return res.status(400).send('Project name is required');
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id`,
    [name.trim(), description?.trim() || null],
  );
  res.redirect(`/admin/projects/${rows[0].id}`);
});

// ── Project detail (LDAP group mappings) ─────────────────────────

router.get('/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { rows: [project] } = await db.query<{ id: number; name: string; description: string | null; org_id: number | null }>(
    `SELECT id, name, description, org_id FROM projects WHERE id = $1`,
    [id],
  );
  if (!project) return res.status(404).send('Project not found');

  const [{ rows: mappedGroups }, allGroups, orgs] = await Promise.all([
    db.query<{ ldap_group: string }>(
      `SELECT ldap_group FROM project_ldap_groups WHERE project_id = $1 ORDER BY ldap_group`,
      [id],
    ),
    listGroups().catch(() => [] as string[]),
    getAllOrgs(),
  ]);

  const mapped = mappedGroups.map((r) => r.ldap_group);
  res.render('admin/projects/detail', { project, mapped, allGroups, orgs });
});

// ── Add LDAP group to project ─────────────────────────────────────

router.post('/:id/groups', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { ldapGroup } = req.body as { ldapGroup: string };
  if (!ldapGroup) return res.status(400).send('ldapGroup required');
  await db.query(
    `INSERT INTO project_ldap_groups (project_id, ldap_group) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [id, ldapGroup],
  );
  const { rows: [proj] } = await db.query<{ org_id: number | null }>(
    `SELECT org_id FROM projects WHERE id = $1`,
    [id],
  );
  if (proj?.org_id) {
    await upsertOrgGroupMapping(proj.org_id, ldapGroup, 'member');
  }
  res.redirect(`/admin/projects/${id}`);
});

// ── Remove LDAP group from project ───────────────────────────────

router.post('/:id/groups/remove', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { ldapGroup } = req.body as { ldapGroup: string };
  await db.query(
    `DELETE FROM project_ldap_groups WHERE project_id = $1 AND ldap_group = $2`,
    [id, ldapGroup],
  );
  res.redirect(`/admin/projects/${id}`);
});

// ── Update project metadata ───────────────────────────────────────

router.post('/:id/edit', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, description } = req.body as Record<string, string>;
  if (!name?.trim()) return res.status(400).send('Project name is required');
  await db.query(
    `UPDATE projects SET name = $1, description = $2 WHERE id = $3`,
    [name.trim(), description?.trim() || null, id],
  );
  res.redirect(`/admin/projects/${id}`);
});

// ── Link / unlink org ─────────────────────────────────────────────

router.post('/:id/set-org', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { orgId } = req.body as { orgId: string };
  const parsed = orgId ? parseInt(orgId, 10) : null;
  await db.query(`UPDATE projects SET org_id = $1 WHERE id = $2`, [parsed || null, id]);
  res.redirect(`/admin/projects/${id}`);
});

// ── Delete project ────────────────────────────────────────────────

router.post('/:id/delete', async (req: Request, res: Response) => {
  const { id } = req.params;
  await db.query(`DELETE FROM projects WHERE id = $1`, [id]);
  res.redirect('/admin/projects');
});

export default router;
