import { Request, Response, NextFunction } from 'express';

export function requireProjectLead(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated() || !req.user) {
    res.redirect('/login');
    return;
  }
  const { user } = req;
  if (user.isSystemAdmin || user.isLocalAdmin ||
      req.currentOrgMembership?.role === 'org_admin' ||
      req.currentOrgMembership?.role === 'project_lead') {
    return next();
  }
  res.status(403).send('Access denied: project lead privileges required.');
}
