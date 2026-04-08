import { Router } from 'express';
import passport from 'passport';

const router = Router();

router.get('/login', (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/dashboard');
  }
  res.render('login', {
    error: req.query['error'] ? 'Authentication failed. Please try again.' : null,
  });
});

// Initiates the OIDC redirect to Authentik
router.get('/auth/login', passport.authenticate('oidc'));

// Authentik redirects back here after the user authenticates
router.get(
  '/auth/callback',
  passport.authenticate('oidc', { failureRedirect: '/login?error=1' }),
  (_req, res) => {
    res.redirect('/dashboard');
  },
);

router.post('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => res.redirect('/login'));
  });
});

export default router;
