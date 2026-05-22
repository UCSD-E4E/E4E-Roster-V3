import { Request, Response, NextFunction } from 'express';

export function requireSystemAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.isAuthenticated() && req.user?.isSystemAdmin) return next();
  res.status(403).send('Access denied: system admin privileges required.');
}
