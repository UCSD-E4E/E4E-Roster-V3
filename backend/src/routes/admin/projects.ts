import { Router, Request, Response } from 'express';
import { db } from '../../services/db';
import { listGroups } from '../../services/ldap';

const router = Router();
// requireOrgAdmin applied at admin/index.ts level

router.get('/', async (_req: Request, res: Response) => {
  const { rows: projects } = await db.query<{
    id: number; name: string; description: string | null; group_count: string;
  }>(
    `SELECT p.id, p.name, p.description, COUNT(plg.ldap_group)::text AS group_count
     FROM projects p
     LEFT JOIN project_ldap_groups plg ON plg.project_id = p.id
     GROUP BY p.id ORDER BY p.name`,
  );
  res.render('admin/projects/index', { projects });
});

router.post('/', async (req: Request, res: Response) => {
  const { name, description } = req.body as Record<string, string>;
  if (!name?.trim()) return res.status(400).send('Project name is required');
  const orgId = res.locals.currentOrg?.id ?? null;
  const { rows } = await db.query<{ id: number }>(
    'INSERT INTO projects (name, description, org_id) VALUES ($1, $2, $3) RETURNING id',
    [name.trim(), description?.trim() || null, orgId],
  );
  res.redirect(`${res.locals.orgBase}/admin/projects/${rows[0].id}`);
});

router.get('/:id', async (req: Request, res: Response) => {
  const { rows: [project] } = await db.query<{ id: number; name: string; description: string | null }>(
    'SELECT id, name, description FROM projects WHERE id = $1',
    [req.params.id],
  );
  if (!project) return res.status(404).send('Project not found');

  const { rows: mappedGroups } = await db.query<{ ldap_group: string }>(
    'SELECT ldap_group FROM project_ldap_groups WHERE project_id = $1 ORDER BY ldap_group',
    [req.params.id],
  );
<<<<<<< HEAD
  const allGroups = await udm.listGroups().catch(() => []);
  res.render('admin/projects/detail', { project, mapped: mappedGroups.map((r) => r.ldap_group), allGroups });
=======

  let allGroups: string[] = [];
  try {
    allGroups = await listGroups();
  } catch (err) {
    console.error('[admin/projects] Failed to fetch groups:', err);
  }

  const mapped = mappedGroups.map((r) => r.ldap_group);
  res.render('admin/projects/detail', { project, mapped, allGroups });
>>>>>>> main
});

router.post('/:id/groups', async (req: Request, res: Response) => {
  const { ldapGroup } = req.body as { ldapGroup: string };
  if (!ldapGroup) return res.status(400).send('ldapGroup required');
  await db.query(
    'INSERT INTO project_ldap_groups (project_id, ldap_group) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.params.id, ldapGroup],
  );
  res.redirect(`${res.locals.orgBase}/admin/projects/${req.params.id}`);
});

router.post('/:id/groups/remove', async (req: Request, res: Response) => {
  const { ldapGroup } = req.body as { ldapGroup: string };
  await db.query(
    'DELETE FROM project_ldap_groups WHERE project_id = $1 AND ldap_group = $2',
    [req.params.id, ldapGroup],
  );
  res.redirect(`${res.locals.orgBase}/admin/projects/${req.params.id}`);
});

router.post('/:id/edit', async (req: Request, res: Response) => {
  const { name, description } = req.body as Record<string, string>;
  if (!name?.trim()) return res.status(400).send('Project name is required');
  await db.query(
    'UPDATE projects SET name = $1, description = $2 WHERE id = $3',
    [name.trim(), description?.trim() || null, req.params.id],
  );
  res.redirect(`${res.locals.orgBase}/admin/projects/${req.params.id}`);
});

router.post('/:id/delete', async (req: Request, res: Response) => {
  await db.query('DELETE FROM projects WHERE id = $1', [req.params.id]);
  res.redirect(`${res.locals.orgBase}/admin/projects`);
});

export default router;
