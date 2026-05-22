import { Request, Response, NextFunction } from 'express';

export function requireOrgMember(req: Request, res: Response, next: NextFunction): void {
  if (!req.isAuthenticated()) { res.status(401).send('Not authenticated.'); return; }
  if (req.user?.isSystemAdmin) return next();
  const slug = req.params.orgSlug;
  const orgRole = req.user?.orgRoles?.find(r => r.orgSlug === slug);
  if (orgRole) return next();
  res.status(403).send('Access denied: you are not a member of this organisation.');
}
