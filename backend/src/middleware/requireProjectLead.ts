import { Request, Response, NextFunction } from 'express';
import { isAnyOrgAdmin } from '../types/user';

export function requireProjectLead(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated() || !req.user) {
    res.redirect('/login');
    return;
  }
  const { user } = req;
  if (user.isSystemAdmin || isAnyOrgAdmin(user) || user.orgs.some((o) => o.role === 'project_lead')) {
    return next();
  }
  res.status(403).send('Access denied: project lead privileges required.');
}
