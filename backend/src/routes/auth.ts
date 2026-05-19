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
  passport.authenticate('oidc', { failureRedirect: '/login?error=1' }),
  (req: Request, res: Response, next: NextFunction) => {
    const user = req.user as AuthUser;
    req.session.regenerate((regenErr) => {
      if (regenErr) return next(regenErr);
      req.login(user, (loginErr) => {
        if (loginErr) return next(loginErr);
        res.redirect('/');
      });
    });
  },
);

router.post('/logout', (req: Request, res: Response, next: NextFunction) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect('/login'));
  });
});

export default router;
