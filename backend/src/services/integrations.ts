import { db } from './db';

/**
 * Fires a non-blocking GitHub org invite for a user.
 * Failures are logged but do not throw.
 *
 * orgId is passed to the github-app sidecar so it can use the correct
 * per-org GitHub App credentials from org_integrations.
 */
export function triggerGithubInvite(
  githubUsername: string,
  orgId: number | undefined,
  context = 'roster',
): void {
  const base = process.env.GITHUB_APP_URL ?? 'http://github-app:3001';
  fetch(`${base}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ githubUsername, orgId }),
  }).catch((err) =>
    console.warn(`[${context}] GitHub invite trigger failed for ${githubUsername}:`, err),
  );
}

export interface IntegrationSyncResult {
  githubOps: number;
  slackOps: number;
  errors: number;
}

// Applies all LDAP group → GitHub team / Slack channel mappings for the given org.
export async function runIntegrationSync(orgId?: number): Promise<IntegrationSyncResult> {
  const githubBase = process.env.GITHUB_APP_URL ?? 'http://github-app:3001';
  const slackBase  = process.env.SLACK_BOT_URL  ?? 'http://slackbot:3002';

  type MappingRow = { ldap_group: string; service: string; target_id: string };
  type UserRow    = { slack_username: string | null; github_username: string | null; ldap_groups: string[] };

  const mappingQuery = orgId
    ? db.query<MappingRow>(
        'SELECT ldap_group, service, target_id FROM group_mappings WHERE org_id = $1',
        [orgId],
      )
    : db.query<MappingRow>('SELECT ldap_group, service, target_id FROM group_mappings');

  const [{ rows: mappings }, { rows: users }] = await Promise.all([
    mappingQuery,
    db.query<UserRow>('SELECT slack_username, github_username, ldap_groups FROM users'),
  ]);

  if (mappings.length === 0) return { githubOps: 0, slackOps: 0, errors: 0 };

  const githubByGroup = new Map<string, string[]>();
  const slackByGroup  = new Map<string, string[]>();
  for (const m of mappings) {
    const map = m.service === 'github' ? githubByGroup : slackByGroup;
    const list = map.get(m.ldap_group) ?? [];
    list.push(m.target_id);
    map.set(m.ldap_group, list);
  }

  let githubOps = 0, slackOps = 0, errors = 0;

  for (const user of users) {
    for (const group of (user.ldap_groups ?? [])) {
      if (user.github_username) {
        for (const teamSlug of (githubByGroup.get(group) ?? [])) {
          const r = await fetch(`${githubBase}/team-member`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ teamSlug, githubUsername: user.github_username, orgId }),
          }).catch(() => null);
          if (r?.ok) githubOps++; else errors++;
        }
      }
      if (user.slack_username) {
        for (const channelId of (slackByGroup.get(group) ?? [])) {
          const r = await fetch(`${slackBase}/invite`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channelId, slackUserId: user.slack_username, orgId }),
          }).catch(() => null);
          if (r?.ok) slackOps++; else errors++;
        }
      }
    }
  }

  console.log(`[integrations-sync] done — ${githubOps} GitHub ops, ${slackOps} Slack ops, ${errors} errors`);
  return { githubOps, slackOps, errors };
}
