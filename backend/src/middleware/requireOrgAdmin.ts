import { Request, Response, NextFunction } from 'express';

// Must be used after requireOrgMember (relies on req.currentOrgMembership).
export function requireOrgAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated() || !req.user) {
    res.redirect('/login');
    return;
  }

  if (req.user.isSystemAdmin || req.user.isLocalAdmin) {
    return next();
  }

  if (req.currentOrgMembership?.role === 'org_admin') {
    return next();
  }

  res.status(403).send('Access denied: org admin privileges required.');
}
