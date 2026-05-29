import { Router, Request, Response, NextFunction } from 'express';
import { requireOrgAdmin } from '../../middleware/requireOrgAdmin';
import { requireOrgAdminOrProjectLead } from '../../middleware/requireOrgAdminOrProjectLead';
import usersRouter from './users';
import integrationsRouter from './integrations';
import projectsRouter from './projects';
import groupsRouter from './groups';
import settingsRouter from './settings';

const router = Router();

router.get('/', requireOrgAdmin, (_req: Request, res: Response) => res.redirect(res.locals.orgBase + '/admin/users'));

// Project leads can read the user list; all other admin routes require org_admin.
router.use('/users', (req: Request, res: Response, next: NextFunction) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '')) {
    return requireOrgAdminOrProjectLead(req, res, next);
  }
  return requireOrgAdmin(req, res, next);
}, usersRouter);

router.use('/projects',     requireOrgAdmin, projectsRouter);
router.use('/integrations', requireOrgAdmin, integrationsRouter);
router.use('/groups',       requireOrgAdmin, groupsRouter);
router.use('/settings',     requireOrgAdmin, settingsRouter);

export default router;
