// Break-glass local admin login — intentionally NOT linked from the main /login page.
// Access by navigating directly to /local-login. Used only for initial system setup
// before SSO is working. Delete the local_admins record via /system/local-admins
// once a real system admin has logged in via SSO.
import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { db } from '../services/db';
import { AuthUser } from '../types/user';

const router = Router();

// 5 attempts per IP per 15 minutes — protects against brute-force even though
// the URL is unlisted, bcrypt is slow, and accounts are monitored.
const localLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts. Please try again in 15 minutes.',
  skipSuccessfulRequests: true,
});

router.get('/local-login', (req: Request, res: Response) => {
  if (req.isAuthenticated()) return res.redirect('/');
  res.render('local-login', { error: null });
});

router.post('/local-login', localLoginLimiter, async (req: Request, res: Response) => {
  const { username, password } = req.body as { username: string; password: string };

  if (!username || !password) {
    return res.render('local-login', { error: 'Username and password are required.' });
  }

  const { rows } = await db.query<{ id: number; password_hash: string; enabled: boolean }>(
    'SELECT id, password_hash, enabled FROM local_admins WHERE username = $1',
    [username.trim()],
  );

  const record = rows[0];
  const valid = record?.enabled && await bcrypt.compare(password, record.password_hash);

  if (!valid) {
    // Log every failed attempt; always show a generic message to avoid username enumeration
    await db.query(
      `INSERT INTO audit_log (actor, action, details) VALUES ($1, 'local_login_failed', $2)`,
      ['<anonymous>', JSON.stringify({ username: username.trim() })],
    ).catch(() => {});
    return res.render('local-login', { error: 'Invalid credentials.' });
  }

  await db.query('UPDATE local_admins SET last_used_at = NOW() WHERE id = $1', [record.id]);

  const user: AuthUser = {
    id:            `local:${username}`,
    name:          username,
    email:         '',
    username:      username.trim(),
    groups:        [],
    isSystemAdmin: false,
    isLocalAdmin:  true,
    orgs:          [],
  };

  // Regenerate session on login to prevent session fixation.
  req.session.regenerate((regenErr) => {
    if (regenErr) return res.render('local-login', { error: 'Login failed. Please try again.' });
    req.login(user, (loginErr) => {
      if (loginErr) return res.render('local-login', { error: 'Login failed. Please try again.' });
      res.redirect('/');
    });
  });
});

router.post('/local-logout', (req: Request, res: Response) => {
  req.logout(() => req.session.destroy(() => res.redirect('/login')));
});

export default router;
