import { Router, Request, Response } from 'express';
import { requireSystemAdmin } from '../../middleware/requireSystemAdmin';
import { db, getAllOrgs, getAllOrgLdapMappings, upsertOrgGroupMapping, removeOrgGroupMapping } from '../../services/db';
import * as ldap from '../../services/ldap';

const router = Router();
router.use(requireSystemAdmin);

// ── Org list ──────────────────────────────────────────────────────

router.get('/orgs', async (_req: Request, res: Response) => {
  const [orgs, mappings, allGroups] = await Promise.all([
    getAllOrgs(),
    getAllOrgLdapMappings(),
    ldap.listGroups().catch(() => [] as string[]),
  ]);

  const mappingsByOrg = mappings.reduce<Record<number, typeof mappings>>((acc, m) => {
    (acc[m.org_id] ??= []).push(m);
    return acc;
  }, {});

  res.render('system/orgs', { orgs, mappingsByOrg, allGroups });
});

// ── Create org ────────────────────────────────────────────────────

router.post('/orgs', async (req: Request, res: Response) => {
  const { name, slug, description, theme_color } = req.body as Record<string, string>;
  if (!name?.trim() || !slug?.trim()) {
    return res.status(400).send('Name and slug are required.');
  }
  await db.query(
    `INSERT INTO orgs (name, slug, description, theme_color)
     VALUES ($1, $2, $3, $4)`,
    [name.trim(), slug.trim().toLowerCase(), description?.trim() || null, theme_color?.trim() || null],
  );
  res.redirect('/system/orgs');
});

// ── Edit org ──────────────────────────────────────────────────────

router.post('/orgs/:id/edit', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { name, description, theme_color } = req.body as Record<string, string>;
  await db.query(
    `UPDATE orgs SET name = $1, description = $2, theme_color = $3, updated_at = NOW()
     WHERE id = $4`,
    [name.trim(), description?.trim() || null, theme_color?.trim() || null, id],
  );
  res.redirect('/system/orgs');
});

// ── Delete org ────────────────────────────────────────────────────

router.post('/orgs/:id/delete', async (req: Request, res: Response) => {
  await db.query(`DELETE FROM orgs WHERE id = $1`, [req.params.id]);
  res.redirect('/system/orgs');
});

// ── Org LDAP group mappings ───────────────────────────────────────

router.post('/orgs/:id/mappings', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { ldap_group, role } = req.body as Record<string, string>;
  if (!ldap_group?.trim() || !role) return res.status(400).send('ldap_group and role are required.');
  await upsertOrgGroupMapping(parseInt(id, 10), ldap_group.trim(), role);
  res.redirect('/system/orgs');
});

router.post('/orgs/:id/mappings/remove', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { ldap_group } = req.body as Record<string, string>;
  await removeOrgGroupMapping(parseInt(id, 10), ldap_group);
  res.redirect('/system/orgs');
});

// ── System admin LDAP groups ──────────────────────────────────────

router.get('/admin-groups', async (_req: Request, res: Response) => {
  const { rows } = await db.query<{ ldap_group: string }>(
    `SELECT ldap_group FROM system_ldap_groups ORDER BY ldap_group`,
  );
  const allGroups = await ldap.listGroups().catch(() => [] as string[]);
  res.render('system/admin-groups', { systemGroups: rows.map(r => r.ldap_group), allGroups });
});

router.post('/admin-groups', async (req: Request, res: Response) => {
  const { ldap_group } = req.body as Record<string, string>;
  if (!ldap_group?.trim()) return res.status(400).send('ldap_group is required.');
  await db.query(
    `INSERT INTO system_ldap_groups (ldap_group) VALUES ($1) ON CONFLICT DO NOTHING`,
    [ldap_group.trim()],
  );
  res.redirect('/system/admin-groups');
});

router.post('/admin-groups/remove', async (req: Request, res: Response) => {
  const { ldap_group } = req.body as Record<string, string>;
  await db.query(`DELETE FROM system_ldap_groups WHERE ldap_group = $1`, [ldap_group]);
  res.redirect('/system/admin-groups');
});

export default router;
