import { Router, Request, Response } from 'express';
import { requireAdmin } from '../../middleware/requireAdmin';
import { db } from '../../services/db';

const router = Router();
router.use(requireAdmin);

// ── Page ─────────────────────────────────────────────────────────

router.get('/', async (req: Request, res: Response) => {
  const { rows: groupRows } = await db.query<{ grp: string }>(
    `SELECT DISTINCT unnest(ldap_groups) AS grp FROM users ORDER BY grp`,
  );
  const groups = groupRows.map((r) => r.grp);

  const selectedGroup = (req.query.group as string) || null;
  let mappings: { id: number; service: string; target_id: string; target_name: string }[] = [];

  if (selectedGroup) {
    const { rows } = await db.query(
      `SELECT id, service, target_id, target_name
       FROM group_mappings WHERE ldap_group = $1 ORDER BY service, target_name`,
      [selectedGroup],
    );
    mappings = rows;
  }

  res.render('admin/integrations/index', { groups, selectedGroup, mappings });
});

// ── Add mapping ───────────────────────────────────────────────────

router.post('/mappings', async (req: Request, res: Response) => {
  const { ldapGroup, service, targetId, targetName } = req.body as Record<string, string>;
  if (!ldapGroup || !service || !targetId || !targetName) {
    return res.status(400).send('Missing required fields');
  }
  await db.query(
    `INSERT INTO group_mappings (ldap_group, service, target_id, target_name)
     VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
    [ldapGroup, service, targetId, targetName],
  );
  res.redirect(`/admin/integrations?group=${encodeURIComponent(ldapGroup)}`);
});

// ── Remove mapping ────────────────────────────────────────────────

router.post('/mappings/:id/delete', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { ldapGroup } = req.body as { ldapGroup: string };
  await db.query('DELETE FROM group_mappings WHERE id = $1', [id]);
  res.redirect(`/admin/integrations?group=${encodeURIComponent(ldapGroup)}`);
});

// ── Integration sync ─────────────────────────────────────────────

router.post('/sync', async (_req: Request, res: Response) => {
  try {
    const result = await runIntegrationSync();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, message: String(err) });
  }
});

async function runIntegrationSync(): Promise<{ githubOps: number; slackOps: number; googleOps: number; errors: number }> {
  const githubBase = process.env.GITHUB_APP_URL ?? 'http://github-app:3001';
  const slackBase  = process.env.SLACK_BOT_URL  ?? 'http://slackbot:3002';
  const gsuiteBase = process.env.GSUITE_URL      ?? 'http://gsuite:3003';

  type MappingRow = { ldap_group: string; service: string; target_id: string };
  type UserRow    = { email: string | null; slack_username: string | null; github_username: string | null; ldap_groups: string[] };

  const [{ rows: mappings }, { rows: users }] = await Promise.all([
    db.query<MappingRow>('SELECT ldap_group, service, target_id FROM group_mappings'),
    db.query<UserRow>('SELECT email, slack_username, github_username, ldap_groups FROM users'),
  ]);

  if (mappings.length === 0) return { githubOps: 0, slackOps: 0, googleOps: 0, errors: 0 };

  // Index mappings by group+service
  const githubByGroup = new Map<string, string[]>();
  const slackByGroup  = new Map<string, string[]>();
  const googleByGroup = new Map<string, string[]>();
  for (const m of mappings) {
    const map = m.service === 'github' ? githubByGroup
              : m.service === 'slack'  ? slackByGroup
              :                          googleByGroup;
    const list = map.get(m.ldap_group) ?? [];
    list.push(m.target_id);
    map.set(m.ldap_group, list);
  }

  let githubOps = 0, slackOps = 0, googleOps = 0, errors = 0;

  for (const user of users) {
    for (const group of (user.ldap_groups ?? [])) {
      // GitHub team memberships
      if (user.github_username) {
        for (const teamSlug of (githubByGroup.get(group) ?? [])) {
          const r = await fetch(`${githubBase}/team-member`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamSlug, githubUsername: user.github_username }),
          }).catch(() => null);
          if (r?.ok) githubOps++; else errors++;
        }
      }
      // Slack channel invites
      if (user.slack_username) {
        for (const channelId of (slackByGroup.get(group) ?? [])) {
          const r = await fetch(`${slackBase}/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelId, slackUserId: user.slack_username }),
          }).catch(() => null);
          if (r?.ok) slackOps++; else errors++;
        }
      }
      // Google Group memberships
      if (user.email) {
        for (const groupEmail of (googleByGroup.get(group) ?? [])) {
          const r = await fetch(`${gsuiteBase}/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ groupEmail, userEmail: user.email }),
          }).catch(() => null);
          if (r?.ok) googleOps++; else errors++;
        }
      }
    }
  }

  console.log(`[integrations-sync] done — ${githubOps} GitHub ops, ${slackOps} Slack ops, ${googleOps} Google ops, ${errors} errors`);
  return { githubOps, slackOps, googleOps, errors };
}

// ── API proxies (used by the page's JS dropdowns) ─────────────────

router.get('/api/teams', async (_req: Request, res: Response) => {
  try {
    const base = process.env.GITHUB_APP_URL ?? 'http://github-app:3001';
    const r = await fetch(`${base}/teams`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'GitHub app unreachable', detail: String(err) });
  }
});

router.get('/api/google-groups', async (_req: Request, res: Response) => {
  try {
    const base = process.env.GSUITE_URL ?? 'http://gsuite:3003';
    const r = await fetch(`${base}/groups`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'GSuite service unreachable', detail: String(err) });
  }
});

router.get('/api/channels', async (_req: Request, res: Response) => {
  try {
    const base = process.env.SLACK_BOT_URL ?? 'http://slackbot:3002';
    const r = await fetch(`${base}/channels`);
    const data = await r.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Slackbot unreachable', detail: String(err) });
  }
});

export default router;
