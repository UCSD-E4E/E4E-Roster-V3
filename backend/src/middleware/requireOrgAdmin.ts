import { Request, Response, NextFunction } from 'express';

export function requireOrgAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated()) { res.status(401).send('Not authenticated.'); return; }
  // System admins have full access to every org
  if (req.user?.isSystemAdmin) return next();
  const slug = req.params.orgSlug;
  const orgRole = req.user?.orgRoles?.find(r => r.orgSlug === slug);
  if (orgRole?.role === 'org_admin') return next();
  res.status(403).send('Access denied: org admin privileges required.');
}
