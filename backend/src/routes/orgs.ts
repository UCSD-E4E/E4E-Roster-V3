import { Router, Request, Response, NextFunction } from 'express';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { getAllOrgs } from '../services/db';
import { OrganizationSelector, type SelectableOrganization } from '../ui/org-selector';

const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  const { user } = req;
  try {
    const allOrgs = await getAllOrgs();
    const colorBySlug = new Map(allOrgs.map(o => [o.slug, o.theme_color ?? null]));

    let organizations: SelectableOrganization[];
    if (user?.isSystemAdmin || user?.isLocalAdmin) {
      organizations = allOrgs.map(o => ({
          orgId: o.id, orgSlug: o.slug, orgName: o.name,
          role: 'org_admin', themeColor: o.theme_color ?? null,
        }));
    } else {
      organizations = (user?.orgs ?? []).map(o => ({
        ...o, themeColor: colorBySlug.get(o.orgSlug) ?? null,
      }));
    }
    res.type('html').send(`<!DOCTYPE html>${renderToString(React.createElement(OrganizationSelector, {
      organizations,
      isSystemAdmin: user?.isSystemAdmin === true || user?.isLocalAdmin === true,
    }))}`);
  } catch (err) {
    return next(err);
  }
});

export default router;
