import { Router, Response } from 'express';
import { requireOrgAdmin } from '../../middleware/requireOrgAdmin';
import usersRouter from './users';
import integrationsRouter from './integrations';
import projectsRouter from './projects';
import groupsRouter from './groups';
import settingsRouter from './settings';

const router = Router();
router.use(requireOrgAdmin);

router.get('/', (_req, res: Response) => res.redirect(res.locals.orgBase + '/admin/users'));

router.use('/users',        usersRouter);
router.use('/projects',     projectsRouter);
router.use('/integrations', integrationsRouter);
router.use('/groups',       groupsRouter);
router.use('/settings',     settingsRouter);

export default router;
