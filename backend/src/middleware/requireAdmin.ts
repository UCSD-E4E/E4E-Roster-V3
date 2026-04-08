import { Request, Response, NextFunction } from 'express';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.isAuthenticated() && req.user?.isAdmin) {
    return next();
  }
  res.status(403).send('Access denied: admin privileges required.');
}
