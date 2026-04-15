import { Request, Response, NextFunction } from 'express';

/**
 * Allows access to admins OR project leads.
 * Admins always pass through (they have a superset of PL permissions).
 */
export function requireProjectLead(req: Request, res: Response, next: NextFunction): void {
  if (req.isAuthenticated() && (req.user?.isAdmin || req.user?.isProjectLead)) {
    return next();
  }
  res.status(403).send('Access denied: project lead privileges required.');
}
