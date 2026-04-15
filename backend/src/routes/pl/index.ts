import { Router, Request, Response } from 'express';
import { requireProjectLead } from '../../middleware/requireProjectLead';
import { db } from '../../services/db';
import usersRouter from './users';

const router = Router();
router.use(requireProjectLead);

router.get('/', (_req, res) => res.redirect('/pl/projects'));

// Project list — derived from the logged-in PL's LDAP group memberships
router.get('/projects', async (req: Request, res: Response) => {
  const userGroups: string[] = req.user?.groups ?? [];

  // Admin sees all projects; PL sees only projects they belong to (by LDAP group overlap)
  let projects: { id: number; name: string; description: string | null; member_count: string }[];
  if (req.user?.isAdmin) {
    ({ rows: projects } = await db.query(
      `SELECT p.id, p.name, p.description,
              COUNT(DISTINCT u.id)::text AS member_count
       FROM projects p
       LEFT JOIN project_ldap_groups plg ON plg.project_id = p.id
       LEFT JOIN users u ON plg.ldap_group = ANY(u.ldap_groups)
       GROUP BY p.id ORDER BY p.name`,
    ));
  } else {
    if (userGroups.length === 0) return res.render('pl/projects', { projects: [] });
    ({ rows: projects } = await db.query(
      `SELECT p.id, p.name, p.description,
              COUNT(DISTINCT u.id)::text AS member_count
       FROM projects p
       JOIN project_ldap_groups plg ON plg.project_id = p.id
       LEFT JOIN users u ON plg.ldap_group = ANY(u.ldap_groups)
       WHERE plg.ldap_group = ANY($1)
       GROUP BY p.id ORDER BY p.name`,
      [userGroups],
    ));
  }

  res.render('pl/projects', { projects });
});

router.use('/projects/:projectId/users', usersRouter);

export default router;
