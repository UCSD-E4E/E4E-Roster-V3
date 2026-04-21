import { Router, Request, Response } from 'express';
import { requireAdmin } from '../../middleware/requireAdmin';
import { createGroup } from '../../services/udm';
import { db } from '../../services/db';

const router = Router();
router.use(requireAdmin);

router.get('/new', async (req: Request, res: Response) => {
  const { rows: projects } = await db.query<{ id: number; name: string }>(
    'SELECT id, name FROM projects ORDER BY name',
  );

  const githubBase = process.env.GITHUB_APP_URL ?? 'http://github-app:3001';
  const slackBase  = process.env.SLACK_BOT_URL  ?? 'http://slackbot:3002';

  const [teamsRes, channelsRes] = await Promise.allSettled([
    fetch(`${githubBase}/teams`).then((r) => r.json()),
    fetch(`${slackBase}/channels`).then((r) => r.json()),
  ]);

  const teams    = teamsRes.status    === 'fulfilled' ? (teamsRes.value    as { slug: string; name: string }[]) : [];
  const channels = channelsRes.status === 'fulfilled' ? (channelsRes.value as { id: string; name: string }[])  : [];

  res.render('admin/groups/new', {
    projects,
    teams,
    channels,
    error: req.query.error as string | undefined,
  });
});

router.post('/', async (req: Request, res: Response) => {
  const { groupName, projectId, githubTeamSlug, githubTeamName, slackChannelId, slackChannelName } =
    req.body as Record<string, string>;

  const name = groupName?.trim();
  if (!name) {
    return res.redirect('/admin/groups/new?error=Group+name+is+required');
  }

  const result = await createGroup(name);
  if (result.status === 'failed') {
    return res.redirect(`/admin/groups/new?error=${encodeURIComponent(result.message)}`);
  }

  const actor = (req.user as { username?: string })?.username ?? 'admin';
  await db.query(
    `INSERT INTO audit_log (actor, action, details) VALUES ($1, 'create_ldap_group', $2)`,
    [actor, JSON.stringify({ groupName: name, alreadyExisted: result.status === 'already_exists' })],
  );

  if (projectId) {
    await db.query(
      `INSERT INTO project_ldap_groups (project_id, ldap_group) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [parseInt(projectId, 10), name],
    ).catch(() => { /* ignore if project gone */ });
  }

  if (githubTeamSlug && githubTeamName) {
    await db.query(
      `INSERT INTO group_mappings (ldap_group, service, target_id, target_name)
       VALUES ($1, 'github', $2, $3) ON CONFLICT DO NOTHING`,
      [name, githubTeamSlug, githubTeamName],
    );
  }

  if (slackChannelId && slackChannelName) {
    await db.query(
      `INSERT INTO group_mappings (ldap_group, service, target_id, target_name)
       VALUES ($1, 'slack', $2, $3) ON CONFLICT DO NOTHING`,
      [name, slackChannelId, slackChannelName],
    );
  }

  res.redirect('/admin/integrations?created=' + encodeURIComponent(name));
});

export default router;
