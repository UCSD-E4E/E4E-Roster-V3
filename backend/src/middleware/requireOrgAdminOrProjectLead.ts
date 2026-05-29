import { Request, Response, NextFunction } from 'express';

// Allows org_admin, project_lead, system admin, and local admin.
// Must be used after requireOrgMember (relies on req.currentOrgMembership).
export function requireOrgAdminOrProjectLead(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated() || !req.user) {
    res.redirect('/login');
    return;
  }

  if (req.user.isSystemAdmin || req.user.isLocalAdmin) {
    return next();
  }

  const role = req.currentOrgMembership?.role;
  if (role === 'org_admin' || role === 'project_lead') {
    return next();
  }

  res.status(403).send('Access denied: org admin or project lead privileges required.');
}
