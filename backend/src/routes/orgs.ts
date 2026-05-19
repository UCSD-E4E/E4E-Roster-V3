import { Router, Request, Response } from 'express';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const { user } = req;
  res.render('orgs', { orgs: user?.orgs ?? [] });
});

export default router;
