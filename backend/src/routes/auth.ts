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
router.get('/auth/login', passport.authenticate('oidc'));

// Authentik redirects back here after the user authenticates.
// Session is regenerated after successful auth to prevent session fixation.
router.get(
  '/auth/callback',
  (req: Request, res: Response, next: NextFunction) => {
    passport.authenticate('oidc', (err: Error | null, user: AuthUser | false, info: unknown) => {
      if (err) {
        console.error('[auth/callback] strategy error:', err);
        return next(err);
      }
      if (!user) {
        console.error('[auth/callback] authentication failed');
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
