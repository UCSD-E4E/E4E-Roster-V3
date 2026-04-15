/**
 * Cross-references Slack workspace members against the roster DB.
 *
 * Match strategy (in order):
 *   1. Email address  — most reliable, works for accounts created outside this platform
 *   2. slack_username — matches accounts where the username was set manually in the roster
 *
 * Results are written back to the DB and a mismatch report is returned for
 * surfacing in the admin UI.
 */
import { listWorkspaceMembers, SlackMember } from './slack';
import { db } from './db';
import type { WebClient } from '@slack/web-api';

export interface SyncReport {
  matched: number;
  inSlackNotRoster: SlackMember[];   // active Slack members with no roster entry
  inRosterNotSlack: { username: string; email: string; slack_username: string | null }[];
}

export async function syncSlack(client?: WebClient): Promise<SyncReport> {
  console.log('[slack-sync] fetching workspace members');
  const slackMembers = await listWorkspaceMembers();
  const activeMembers = slackMembers.filter((m) => !m.deleted);

  console.log(`[slack-sync] ${activeMembers.length} active workspace members`);

  type RosterRow = { username: string; email: string; slack_username: string | null; ldap_groups: string[] };
  const { rows: rosterUsers }: { rows: RosterRow[] } = await db.query(
    'SELECT username, email, slack_username, ldap_groups FROM users',
  );

  const rosterByEmail = new Map(rosterUsers.map((u) => [u.email?.toLowerCase(), u]));
  const rosterBySlackName = new Map(
    rosterUsers.filter((u) => u.slack_username).map((u) => [u.slack_username!.toLowerCase(), u]),
  );

  let matched = 0;
  const matchedUsers: { slackId: string; ldap_groups: string[] }[] = [];
  const inSlackNotRoster: SlackMember[] = [];

  for (const member of activeMembers) {
    const byEmail = member.email ? rosterByEmail.get(member.email.toLowerCase()) : undefined;
    const byName = rosterBySlackName.get(member.username.toLowerCase());
    const rosterEntry = byEmail ?? byName;

    if (rosterEntry) {
      // Update the slack_username with the stable member ID if not already set
      if (rosterEntry.slack_username !== member.id) {
        await db.query(
          'UPDATE users SET slack_username = $1, updated_at = NOW() WHERE username = $2',
          [member.id, rosterEntry.username],
        );
      }
      matchedUsers.push({ slackId: member.id, ldap_groups: rosterEntry.ldap_groups ?? [] });
      matched++;
    } else {
      inSlackNotRoster.push(member);
    }
  }

  // Roster users with a slack_username that no longer appears in the workspace
  const activeSlackIds = new Set(activeMembers.map((m) => m.id));
  const inRosterNotSlack = rosterUsers.filter(
    (u) => u.slack_username && !activeSlackIds.has(u.slack_username),
  );

  console.log(
    `[slack-sync] done — ${matched} matched, ${inSlackNotRoster.length} unmatched Slack members, ` +
    `${inRosterNotSlack.length} roster entries not in Slack`,
  );

  // Apply group → channel mappings for matched users
  if (client) {
    await applyChannelMappings(client, matchedUsers);
  }

  return { matched, inSlackNotRoster, inRosterNotSlack };
}

async function applyChannelMappings(
  client: WebClient,
  users: { slackId: string; ldap_groups: string[] }[],
): Promise<void> {
  type MappingRow = { ldap_group: string; target_id: string };
  const { rows: mappings } = await db.query<MappingRow>(
    `SELECT ldap_group, target_id FROM group_mappings WHERE service = 'slack'`,
  );
  if (mappings.length === 0) return;

  const mappingsByGroup = new Map<string, string[]>();
  for (const m of mappings) {
    const channels = mappingsByGroup.get(m.ldap_group) ?? [];
    channels.push(m.target_id);
    mappingsByGroup.set(m.ldap_group, channels);
  }

  for (const user of users) {
    for (const group of user.ldap_groups) {
      const channels = mappingsByGroup.get(group) ?? [];
      for (const channelId of channels) {
        try {
          // Ensure bot is in the channel before inviting (public channels only)
          try {
            await client.conversations.join({ channel: channelId });
          } catch {
            // Private channels can't be joined this way — bot must be added manually
          }
          await client.conversations.invite({ channel: channelId, users: user.slackId });
        } catch (err: unknown) {
          const code = (err as { data?: { error?: string } })?.data?.error;
          if (code !== 'already_in_channel' && code !== 'cant_invite_self') {
            console.warn(`[slack-sync] failed to invite ${user.slackId} to ${channelId}:`, code ?? err);
          }
        }
      }
    }
  }
}
