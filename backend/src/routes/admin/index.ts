import { Router } from 'express';
import { requireAdmin } from '../../middleware/requireAdmin';
import usersRouter from './users';

const router = Router();
router.use(requireAdmin);

router.get('/', (_req, res) => res.redirect('/admin/users'));

router.use('/users', usersRouter);

export default router;
