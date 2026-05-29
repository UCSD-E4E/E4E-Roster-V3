import { Router, Request, Response } from 'express';
import { createGroup } from '../../services/ldap';
import { db } from '../../services/db';

const router = Router();
// requireOrgAdmin applied at admin/index.ts level

router.get('/new', async (req: Request, res: Response) => {
  const { rows: projects } = await db.query<{ id: number; name: string }>(
    'SELECT id, name FROM projects ORDER BY name',
  );

  const [teamsRes, channelsRes] = await Promise.allSettled([
    fetch(`${process.env.GITHUB_APP_URL ?? 'http://github-app:3001'}/teams`).then((r) => r.json()),
    fetch(`${process.env.SLACK_BOT_URL  ?? 'http://slackbot:3002'}/channels`).then((r) => r.json()),
  ]);

  res.render('admin/groups/new', {
    projects,
    teams:    teamsRes.status    === 'fulfilled' ? (teamsRes.value    as { slug: string; name: string }[]) : [],
    channels: channelsRes.status === 'fulfilled' ? (channelsRes.value as { id: string; name: string }[])  : [],
    error: req.query.error as string | undefined,
  });
});

router.post('/', async (req: Request, res: Response) => {
  const { groupName, projectId, githubTeamSlug, githubTeamName, slackChannelId, slackChannelName } =
    req.body as Record<string, string>;

  const name = groupName?.trim();
  if (!name) {
    return res.redirect(`${res.locals.orgBase}/admin/groups/new?error=Group+name+is+required`);
  }

  const result = await createGroup(name);
  if (result.status === 'failed') {
    return res.redirect(`${res.locals.orgBase}/admin/groups/new?error=${encodeURIComponent(result.message)}`);
  }

  const actor  = req.user?.username ?? 'admin';
  const orgId  = res.locals.currentOrg?.id ?? null;

  await db.query(
    'INSERT INTO audit_log (actor, action, details, org_id) VALUES ($1, $2, $3, $4)',
    [actor, 'create_ldap_group', JSON.stringify({ groupName: name, alreadyExisted: result.status === 'already_exists' }), orgId],
  );

  if (orgId) {
    await db.query(
      'INSERT INTO org_groups (org_id, ldap_group) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [orgId, name],
    );
  }

  if (projectId) {
    await db.query(
      'INSERT INTO project_ldap_groups (project_id, ldap_group) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [parseInt(projectId, 10), name],
    ).catch(() => {});
  }

  if (githubTeamSlug && githubTeamName) {
    await db.query(
      'INSERT INTO group_mappings (ldap_group, service, target_id, target_name, org_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [name, 'github', githubTeamSlug, githubTeamName, orgId],
    );
  }

  if (slackChannelId && slackChannelName) {
    await db.query(
      'INSERT INTO group_mappings (ldap_group, service, target_id, target_name, org_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [name, 'slack', slackChannelId, slackChannelName, orgId],
    );
  }

  res.redirect(`${res.locals.orgBase}/admin/integrations?created=${encodeURIComponent(name)}`);
});

export default router;
