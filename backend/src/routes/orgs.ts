import { Router, Request, Response, NextFunction } from 'express';
import { getAllOrgs } from '../services/db';

const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  const { user } = req;
  try {
    const allOrgs = await getAllOrgs();
    const colorBySlug = new Map(allOrgs.map(o => [o.slug, o.theme_color ?? null]));

    if (user?.isSystemAdmin || user?.isLocalAdmin) {
      return res.render('orgs', {
        orgs: allOrgs.map(o => ({
          orgId: o.id, orgSlug: o.slug, orgName: o.name,
          role: 'org_admin', theme_color: o.theme_color ?? null,
        })),
      });
    }

    res.render('orgs', {
      orgs: (user?.orgs ?? []).map(o => ({ ...o, theme_color: colorBySlug.get(o.orgSlug) ?? null })),
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
