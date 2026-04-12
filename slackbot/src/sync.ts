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

export interface SyncReport {
  matched: number;
  inSlackNotRoster: SlackMember[];   // active Slack members with no roster entry
  inRosterNotSlack: { username: string; slack_username: string | null }[];
}

export async function syncSlack(): Promise<SyncReport> {
  console.log('[slack-sync] fetching workspace members');
  const slackMembers = await listWorkspaceMembers();
  const activeMembers = slackMembers.filter((m) => !m.deleted);

  console.log(`[slack-sync] ${activeMembers.length} active workspace members`);

  const { rows: rosterUsers } = await db.query<{
    username: string;
    email: string;
    slack_username: string | null;
  }>('SELECT username, email, slack_username FROM users');

  const rosterByEmail = new Map(rosterUsers.map((u) => [u.email?.toLowerCase(), u]));
  const rosterBySlackName = new Map(
    rosterUsers.filter((u) => u.slack_username).map((u) => [u.slack_username!.toLowerCase(), u]),
  );

  let matched = 0;
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

  return { matched, inSlackNotRoster, inRosterNotSlack };
}
