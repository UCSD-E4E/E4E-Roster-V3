import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';

const router = Router();

router.get('/', requireAuth, (req, res) => {
  res.render('dashboard', { user: req.user });
});

export default router;
