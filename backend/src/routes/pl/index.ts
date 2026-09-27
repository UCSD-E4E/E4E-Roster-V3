import { Router, Request, Response } from 'express';
import { requireProjectLead } from '../../middleware/requireProjectLead';
import { db } from '../../services/db';
import usersRouter from './users';

const router = Router();
router.use(requireProjectLead);

router.get('/', (_req, res: Response) => res.redirect(res.locals.orgBase + '/pl/projects'));

router.get('/projects', async (req: Request, res: Response) => {
  const userGroups: string[] = req.user?.groups ?? [];
  const isAdmin = req.user && (req.user.isSystemAdmin || req.user.isLocalAdmin ||
    res.locals.currentOrgMembership?.role === 'org_admin');

  let projects: { id: number; name: string; description: string | null; member_count: string }[];

  const orgId = res.locals.currentOrg?.id;

  if (isAdmin) {
    ({ rows: projects } = await db.query(
      `SELECT p.id, p.name, p.description,
              COUNT(DISTINCT uo.username)::text AS member_count
       FROM projects p
       LEFT JOIN project_ldap_groups plg ON plg.project_id = p.id
       LEFT JOIN users u ON plg.ldap_group = ANY(u.ldap_groups)
       LEFT JOIN user_orgs uo ON uo.username = u.username AND uo.org_id = p.org_id
       WHERE p.org_id = $1
       GROUP BY p.id ORDER BY p.name`,
      [orgId],
    ));
  } else {
    if (userGroups.length === 0) return res.render('pl/projects', { projects: [] });
    ({ rows: projects } = await db.query(
      `SELECT p.id, p.name, p.description,
              COUNT(DISTINCT uo.username)::text AS member_count
       FROM projects p
       JOIN project_ldap_groups plg ON plg.project_id = p.id
       LEFT JOIN users u ON plg.ldap_group = ANY(u.ldap_groups)
       LEFT JOIN user_orgs uo ON uo.username = u.username AND uo.org_id = p.org_id
       WHERE p.org_id = $2 AND plg.ldap_group = ANY($1)
       GROUP BY p.id ORDER BY p.name`,
      [userGroups, orgId],
    ));
  }

  res.render('pl/projects', { projects });
});

router.use('/projects/:projectId/users', usersRouter);

export default router;
