import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { db } from '../../services/db';

const router = Router();

router.get('/', (_req, res: Response) => res.redirect('/system/local-admins'));

// ── Local admin management ────────────────────────────────────────────────────

router.get('/local-admins', async (req: Request, res: Response) => {
  const { rows } = await db.query<{
    id: number; username: string; enabled: boolean;
    last_used_at: string | null; created_at: string;
  }>('SELECT id, username, enabled, last_used_at, created_at FROM local_admins ORDER BY created_at');
  res.render('system/local-admins', { admins: rows, error: req.query['error'] });
});

router.post('/local-admins/:id/delete', async (req: Request, res: Response) => {
  await db.query('DELETE FROM local_admins WHERE id = $1', [req.params.id]);
  res.redirect('/system/local-admins');
});

router.post('/local-admins/:id/toggle', async (req: Request, res: Response) => {
  await db.query(
    'UPDATE local_admins SET enabled = NOT enabled, updated_at = NOW() WHERE id = $1',
    [req.params.id],
  );
  res.redirect('/system/local-admins');
});

// Allow creating additional local admins from the UI (e.g. for handoff)
router.post('/local-admins', async (req: Request, res: Response) => {
  const { username, password } = req.body as Record<string, string>;
  if (!username?.trim() || !password) {
    return res.redirect('/system/local-admins?error=Username+and+password+required');
  }
  const hash = await bcrypt.hash(password, 12);
  await db.query(
    `INSERT INTO local_admins (username, password_hash) VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, enabled = TRUE, updated_at = NOW()`,
    [username.trim(), hash],
  );
  res.redirect('/system/local-admins');
});

// ── Org management ────────────────────────────────────────────────────────────

router.get('/orgs', async (req: Request, res: Response) => {
  const { rows: orgs } = await db.query(`
    SELECT o.id, o.slug, o.name, o.description,
           COUNT(uo.username)::text AS member_count
    FROM orgs o
    LEFT JOIN user_orgs uo ON uo.org_id = o.id
    GROUP BY o.id ORDER BY o.name
  `);
  res.render('system/orgs', { orgs, error: req.query['error'] });
});

router.post('/orgs', async (req: Request, res: Response) => {
  const { slug, name, description, themeColor } = req.body as Record<string, string>;
  if (!slug?.trim() || !name?.trim()) {
    return res.redirect('/system/orgs?error=Slug+and+name+required');
  }
  // Strict hex regex prevents CSS injection — only #RRGGBB values reach the template.
  const color = /^#[0-9A-Fa-f]{6}$/.test(themeColor ?? '') ? themeColor : null;
  await db.query(
    'INSERT INTO orgs (slug, name, description, theme_color) VALUES ($1, $2, $3, $4)',
    [slug.trim().toLowerCase(), name.trim(), description?.trim() || null, color],
  );
  res.redirect('/system/orgs');
});

router.post('/orgs/:id/theme', async (req: Request, res: Response) => {
  const { themeColor } = req.body as { themeColor?: string };
  if (!themeColor || !/^#[0-9A-Fa-f]{6}$/.test(themeColor)) { // same hex guard as create
    return res.redirect('/system/orgs?error=Invalid+color+value');
  }
  await db.query('UPDATE orgs SET theme_color = $1 WHERE id = $2', [themeColor, req.params.id]);
  res.redirect('/system/orgs');
});

router.post('/orgs/:id/delete', async (req: Request, res: Response) => {
  await db.query('DELETE FROM orgs WHERE id = $1', [req.params.id]);
  res.redirect('/system/orgs');
});

// ── LDAP group → org role mappings ────────────────────────────────────────────

router.get('/orgs/:id/ldap-mappings', async (req: Request, res: Response) => {
  const orgId = parseInt(req.params.id, 10);
  const [{ rows: [org] }, { rows: mappings }] = await Promise.all([
    db.query('SELECT id, slug, name FROM orgs WHERE id = $1', [orgId]),
    db.query(
      'SELECT id, ldap_group, role FROM org_ldap_group_mappings WHERE org_id = $1 ORDER BY role, ldap_group',
      [orgId],
    ),
  ]);
  if (!org) return res.status(404).send('Org not found');
  res.render('system/ldap-mappings', { org, mappings, error: req.query['error'] });
});

router.post('/orgs/:id/ldap-mappings', async (req: Request, res: Response) => {
  const orgId = parseInt(req.params.id, 10);
  const { ldapGroup, role } = req.body as Record<string, string>;
  if (!ldapGroup?.trim() || !role) {
    return res.redirect(`/system/orgs/${orgId}/ldap-mappings?error=Group+and+role+required`);
  }
  await db.query(
    `INSERT INTO org_ldap_group_mappings (org_id, ldap_group, role)
     VALUES ($1, $2, $3) ON CONFLICT (org_id, ldap_group) DO UPDATE SET role = EXCLUDED.role`,
    [orgId, ldapGroup.trim(), role],
  );
  res.redirect(`/system/orgs/${orgId}/ldap-mappings`);
});

router.post('/orgs/:id/ldap-mappings/:mappingId/delete', async (req: Request, res: Response) => {
  await db.query('DELETE FROM org_ldap_group_mappings WHERE id = $1', [req.params.mappingId]);
  res.redirect(`/system/orgs/${req.params.id}/ldap-mappings`);
});

export default router;
