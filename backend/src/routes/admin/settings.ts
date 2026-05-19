import { Router, Request, Response } from 'express';
import { db } from '../../services/db';
import { encrypt } from '../../services/crypto';

const router = Router();
// requireOrgAdmin applied at admin/index.ts level

router.get('/', async (req: Request, res: Response) => {
  const orgId = res.locals.currentOrg?.id as number | undefined;
  if (!orgId) return res.status(400).send('No org context');

  const { rows: ghRows } = await db.query<{ config: Record<string, string>; enabled: boolean }>(
    'SELECT config, enabled FROM org_integrations WHERE org_id = $1 AND service = $2',
    [orgId, 'github'],
  );
  const { rows: slRows } = await db.query<{ config: Record<string, string>; enabled: boolean }>(
    'SELECT config, enabled FROM org_integrations WHERE org_id = $1 AND service = $2',
    [orgId, 'slack'],
  );

  const ghRow = ghRows[0];
  const slRow = slRows[0];

  const github = {
    enabled:        ghRow?.enabled ?? false,
    appId:          ghRow?.config.appId ?? '',
    installationId: ghRow?.config.installationId ?? '',
    org:            ghRow?.config.org ?? '',
    hasPrivateKey:  !!(ghRow?.config.privateKey),
  };

  const slack = {
    enabled:     slRow?.enabled ?? false,
    teamId:      slRow?.config.teamId ?? '',
    hasBotToken: !!(slRow?.config.botToken),
  };

  res.render('admin/settings/index', {
    github,
    slack,
    saved:  req.query['saved'] as string | undefined,
    error:  req.query['error'] as string | undefined,
  });
});

router.post('/github', async (req: Request, res: Response) => {
  const orgId = res.locals.currentOrg?.id as number | undefined;
  if (!orgId) return res.status(400).send('No org context');

  const { appId, installationId, org, privateKey, enabled } = req.body as Record<string, string>;
  const base = `${res.locals.orgBase}/admin/settings`;

  const { rows } = await db.query<{ config: Record<string, string> }>(
    'SELECT config FROM org_integrations WHERE org_id = $1 AND service = $2',
    [orgId, 'github'],
  );
  const existing = rows[0]?.config ?? {};

  const config: Record<string, string> = {
    appId:          appId?.trim()          || existing.appId          || '',
    installationId: installationId?.trim() || existing.installationId || '',
    org:            org?.trim()            || existing.org            || '',
  };

  if (privateKey?.trim()) {
    config.privateKey = encrypt(privateKey.trim());
  } else if (existing.privateKey) {
    config.privateKey = existing.privateKey;
  }

  await db.query(`
    INSERT INTO org_integrations (org_id, service, config, enabled)
    VALUES ($1, 'github', $2, $3)
    ON CONFLICT (org_id, service) DO UPDATE
      SET config = $2, enabled = $3, updated_at = NOW()
  `, [orgId, JSON.stringify(config), enabled === 'true']);

  res.redirect(`${base}?saved=github`);
});

router.post('/slack', async (req: Request, res: Response) => {
  const orgId = res.locals.currentOrg?.id as number | undefined;
  if (!orgId) return res.status(400).send('No org context');

  const { botToken, teamId, enabled } = req.body as Record<string, string>;
  const base = `${res.locals.orgBase}/admin/settings`;

  const { rows } = await db.query<{ config: Record<string, string> }>(
    'SELECT config FROM org_integrations WHERE org_id = $1 AND service = $2',
    [orgId, 'slack'],
  );
  const existing = rows[0]?.config ?? {};

  const config: Record<string, string> = {
    teamId: teamId?.trim() || existing.teamId || '',
  };

  if (botToken?.trim()) {
    config.botToken = encrypt(botToken.trim());
  } else if (existing.botToken) {
    config.botToken = existing.botToken;
  }

  await db.query(`
    INSERT INTO org_integrations (org_id, service, config, enabled)
    VALUES ($1, 'slack', $2, $3)
    ON CONFLICT (org_id, service) DO UPDATE
      SET config = $2, enabled = $3, updated_at = NOW()
  `, [orgId, JSON.stringify(config), enabled === 'true']);

  res.redirect(`${base}?saved=slack`);
});

export default router;
