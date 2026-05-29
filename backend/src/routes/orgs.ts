import { Router, Request, Response, NextFunction } from 'express';
import { getAllOrgs } from '../services/db';

const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  const { user } = req;
  if (user?.isSystemAdmin || user?.isLocalAdmin) {
    try {
      const allOrgs = await getAllOrgs();
      return res.render('orgs', { orgs: allOrgs.map(o => ({ orgId: o.id, orgSlug: o.slug, orgName: o.name, role: 'org_admin' })) });
    } catch (err) {
      return next(err);
    }
  }
  res.render('orgs', { orgs: user?.orgs ?? [] });
});

export default router;
