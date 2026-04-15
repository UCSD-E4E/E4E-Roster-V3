import { Router } from 'express';
import { requireAdmin } from '../../middleware/requireAdmin';
import usersRouter from './users';
import integrationsRouter from './integrations';
import projectsRouter from './projects';

const router = Router();
router.use(requireAdmin);

router.get('/', (_req, res) => res.redirect('/admin/users'));

router.use('/users', usersRouter);
router.use('/projects', projectsRouter);
router.use('/integrations', integrationsRouter);

export default router;
