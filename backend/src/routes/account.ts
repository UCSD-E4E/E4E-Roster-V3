import { Router, Request, Response } from 'express';
import { db } from '../services/db';
import { AuthUser } from '../types/user';

const router = Router();

type UserRow = {
  first_name: string; last_name: string; email: string;
  secondary_email: string | null; phone: string | null;
  role: string | null; expiry_date: string | null;
  disabled: boolean; github_username: string | null;
  slack_username: string | null; ldap_groups: string[];
};

router.get('/', async (req: Request, res: Response) => {
  const user = req.user as AuthUser;
  const { rows } = await db.query<UserRow>(
    `SELECT first_name, last_name, email, secondary_email, phone, role,
            expiry_date, disabled, github_username, slack_username, ldap_groups
     FROM users WHERE username = $1`,
    [user.username],
  );
  res.render('account', { user, profile: rows[0] ?? null, saved: req.query.saved === '1' });
});

router.post('/', async (req: Request, res: Response) => {
  const user = req.user as AuthUser;
  const { secondaryEmail, phone } = req.body as Record<string, string>;
  const cleanSecondary = secondaryEmail?.trim().toLowerCase() || null;
  const cleanPhone     = phone?.trim() || null;

  await db.query(
    'UPDATE users SET secondary_email = $1, phone = $2, updated_at = NOW() WHERE username = $3',
    [cleanSecondary, cleanPhone, user.username],
  );

  // TODO: write secondaryEmail/phone back to LDAP once extended attribute strategy is decided

  res.redirect(`${res.locals.orgBase}/account?saved=1`);
});

export default router;
