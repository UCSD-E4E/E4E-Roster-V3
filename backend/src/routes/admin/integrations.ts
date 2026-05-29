import { Router, Request, Response } from 'express';
import { db } from '../../services/db';
import { runIntegrationSync } from '../../services/integrations';

const router = Router();
// requireOrgAdmin applied at admin/index.ts level

router.get('/', async (req: Request, res: Response) => {
  const orgId = res.locals.currentOrg?.id;
  const { rows: groupRows } = await db.query<{ grp: string }>(
    `SELECT ldap_group AS grp FROM org_groups WHERE org_id = $1 ORDER BY ldap_group`,
    [orgId],
  );
  const groups = groupRows.map((r) => r.grp);
  const selectedGroup = (req.query.group as string) || null;

  let mappings: { id: number; service: string; target_id: string; target_name: string }[] = [];
  let orgRole: string | null = null;
  if (selectedGroup) {
    const [mappingRows, roleRow] = await Promise.all([
      db.query(
        'SELECT id, service, target_id, target_name FROM group_mappings WHERE ldap_group = $1 ORDER BY service, target_name',
        [selectedGroup],
      ),
      db.query<{ role: string }>(
        'SELECT role FROM org_ldap_group_mappings WHERE org_id = $1 AND ldap_group = $2',
        [orgId, selectedGroup],
      ),
    ]);
    mappings = mappingRows.rows;
    orgRole = roleRow.rows[0]?.role ?? null;
  }

  res.render('admin/integrations/index', { groups, selectedGroup, mappings, orgRole });
});

router.post('/mappings', async (req: Request, res: Response) => {
  const raw = req.body as Record<string, string>;
  const ldapGroup  = raw.ldapGroup?.trim();
  const service    = raw.service?.trim();
  const targetId   = raw.targetId?.trim();
  const targetName = raw.targetName?.trim();
  if (!ldapGroup || !service || !targetId || !targetName) {
    return res.status(400).send('Missing required fields');
  }
  const orgId = res.locals.currentOrg?.id ?? null;
  await db.query(
    'INSERT INTO group_mappings (ldap_group, service, target_id, target_name, org_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [ldapGroup, service, targetId, targetName, orgId],
  );
  res.redirect(`${res.locals.orgBase}/admin/integrations?group=${encodeURIComponent(ldapGroup)}`);
});

router.post('/mappings/:id/delete', async (req: Request, res: Response) => {
  const { ldapGroup } = req.body as { ldapGroup: string };
  await db.query('DELETE FROM group_mappings WHERE id = $1', [req.params.id]);
  res.redirect(`${res.locals.orgBase}/admin/integrations?group=${encodeURIComponent(ldapGroup)}`);
});

router.post('/role', async (req: Request, res: Response) => {
  const { ldapGroup, role } = req.body as Record<string, string>;
  const orgId = res.locals.currentOrg?.id as number;
  if (!ldapGroup) return res.status(400).send('Missing group');
  if (role) {
    await db.query(
      `INSERT INTO org_ldap_group_mappings (org_id, ldap_group, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (org_id, ldap_group) DO UPDATE SET role = EXCLUDED.role`,
      [orgId, ldapGroup, role],
    );
  } else {
    await db.query(
      'DELETE FROM org_ldap_group_mappings WHERE org_id = $1 AND ldap_group = $2',
      [orgId, ldapGroup],
    );
  }
  res.redirect(`${res.locals.orgBase}/admin/integrations?group=${encodeURIComponent(ldapGroup)}`);
});

router.post('/sync', async (_req: Request, res: Response) => {
  try {
    const orgId = res.locals.currentOrg?.id as number | undefined;
    const result = await runIntegrationSync(orgId);
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[admin/integrations/sync]', err);
    res.status(500).json({ ok: false, message: 'Sync failed — see server logs.' });
  }
});

// API proxies for dropdown population in the integrations UI
router.get('/api/teams', async (_req: Request, res: Response) => {
  const orgId = res.locals.currentOrg?.id as number | undefined;
  const qs    = orgId !== undefined ? `?orgId=${orgId}` : '';
  try {
    const r = await fetch(`${process.env.GITHUB_APP_URL ?? 'http://github-app:3001'}/teams${qs}`);
    res.json(await r.json());
  } catch (err) {
    console.error('[admin/integrations/api/teams]', err);
    res.status(502).json({ error: 'GitHub app unreachable' });
  }
});

router.get('/api/channels', async (_req: Request, res: Response) => {
  const orgId = res.locals.currentOrg?.id as number | undefined;
  const qs    = orgId !== undefined ? `?orgId=${orgId}` : '';
  try {
    const r = await fetch(`${process.env.SLACK_BOT_URL ?? 'http://slackbot:3002'}/channels${qs}`);
    res.json(await r.json());
  } catch (err) {
    console.error('[admin/integrations/api/channels]', err);
    res.status(502).json({ error: 'Slackbot unreachable' });
  }
});

export default router;
