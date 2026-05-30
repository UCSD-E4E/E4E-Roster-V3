import { Router, Request, Response, NextFunction } from 'express';
import { db } from '../../services/db';

const router = Router();
// requireOrgAdmin applied at admin/index.ts level

router.get('/', async (_req: Request, res: Response) => {
  const orgId = res.locals.currentOrg?.id;
  const { rows: projects } = await db.query<{
    id: number; name: string; description: string | null; group_count: string;
  }>(
    `SELECT p.id, p.name, p.description, COUNT(plg.ldap_group)::text AS group_count
     FROM projects p
     LEFT JOIN project_ldap_groups plg ON plg.project_id = p.id
     WHERE p.org_id = $1
     GROUP BY p.id ORDER BY p.name`,
    [orgId],
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

// Middleware: verify the project belongs to this org before any /:id route runs.
async function requireProjectOwnership(req: Request, res: Response, next: NextFunction): Promise<void> {
  const orgId = res.locals.currentOrg?.id;
  const { rows: [project] } = await db.query<{ id: number; name: string; description: string | null }>(
    'SELECT id, name, description FROM projects WHERE id = $1 AND org_id = $2',
    [req.params.id, orgId],
  );
  if (!project) {
    res.status(404).send('Project not found');
    return;
  }
  res.locals.project = project;
  next();
}

router.get('/:id', requireProjectOwnership, async (_req: Request, res: Response) => {
  const orgId = res.locals.currentOrg?.id;
  const [{ rows: mappedGroups }, { rows: orgGroupRows }] = await Promise.all([
    db.query<{ ldap_group: string }>(
      'SELECT ldap_group FROM project_ldap_groups WHERE project_id = $1 ORDER BY ldap_group',
      [res.locals.project.id],
    ),
    db.query<{ ldap_group: string }>(
      'SELECT ldap_group FROM org_groups WHERE org_id = $1 ORDER BY ldap_group',
      [orgId],
    ),
  ]);
  res.render('admin/projects/detail', {
    project: res.locals.project,
    mapped: mappedGroups.map((r) => r.ldap_group),
    allGroups: orgGroupRows.map((r) => r.ldap_group),
  });
});

router.post('/:id/groups', requireProjectOwnership, async (req: Request, res: Response) => {
  const { ldapGroup } = req.body as { ldapGroup: string };
  if (!ldapGroup) return res.status(400).send('ldapGroup required');
  await db.query(
    'INSERT INTO project_ldap_groups (project_id, ldap_group) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [res.locals.project.id, ldapGroup],
  );
  res.redirect(`${res.locals.orgBase}/admin/projects/${res.locals.project.id}`);
});

router.post('/:id/groups/remove', requireProjectOwnership, async (req: Request, res: Response) => {
  const { ldapGroup } = req.body as { ldapGroup: string };
  await db.query(
    'DELETE FROM project_ldap_groups WHERE project_id = $1 AND ldap_group = $2',
    [res.locals.project.id, ldapGroup],
  );
  res.redirect(`${res.locals.orgBase}/admin/projects/${res.locals.project.id}`);
});

router.post('/:id/edit', requireProjectOwnership, async (req: Request, res: Response) => {
  const { name, description } = req.body as Record<string, string>;
  if (!name?.trim()) return res.status(400).send('Project name is required');
  await db.query(
    'UPDATE projects SET name = $1, description = $2 WHERE id = $3',
    [name.trim(), description?.trim() || null, res.locals.project.id],
  );
  res.redirect(`${res.locals.orgBase}/admin/projects/${res.locals.project.id}`);
});

router.post('/:id/delete', requireProjectOwnership, async (_req: Request, res: Response) => {
  await db.query('DELETE FROM projects WHERE id = $1', [res.locals.project.id]);
  res.redirect(`${res.locals.orgBase}/admin/projects`);
});

export default router;
