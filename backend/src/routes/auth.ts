import { Router, Request, Response, NextFunction } from 'express';
import passport from 'passport';
import { AuthUser } from '../types/user';

const router = Router();

router.get('/login', (req: Request, res: Response) => {
  if (req.isAuthenticated()) {
    return res.redirect('/');
  }
  res.render('login', {
    error: req.query['error'] ? 'Authentication failed. Please try again.' : null,
  });
});

// Initiates the OIDC redirect to Authentik
router.get('/auth/login', (req: Request, _res: Response, next: NextFunction) => {
  console.log('[auth/login] sessionID:', req.sessionID, '| secure:', req.secure, '| proto:', req.protocol, '| x-fwd-proto:', req.headers['x-forwarded-proto']);
  next();
}, passport.authenticate('oidc'));

// Authentik redirects back here after the user authenticates.
// Session is regenerated after successful auth to prevent session fixation.
router.get(
  '/auth/callback',
  (req: Request, _res: Response, next: NextFunction) => {
    const oidcKey = Object.keys(req.session).find(k => k.startsWith('oidc:'));
    console.log('[auth/callback] sessionID:', req.sessionID, '| oidcKey:', oidcKey ?? 'MISSING', '| sessionKeys:', Object.keys(req.session));
    next();
  },
  (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate('oidc', (err: Error | null, user: AuthUser | false, info: unknown) => {
      if (err) {
        console.error('[auth/callback] strategy error:', err);
        return next(err);
      }
      if (!user) {
        console.error('[auth/callback] auth failed, info:', JSON.stringify(info));
        return res.redirect('/login?error=1');
      }
      req.session.regenerate((regenErr) => {
        if (regenErr) return next(regenErr);
        req.login(user, (loginErr) => {
          if (loginErr) return next(loginErr);
          res.redirect('/');
        });
      });
    })(req, res, next);
  },
);

router.post('/logout', (req: Request, res: Response, next: NextFunction) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect('/login'));
  });
});

export default router;
