/**
 * Cross-references GitHub org members against the roster DB.
 *
 * Match strategy: github_username (case-insensitive login match).
 * Email is not used — GitHub users control their email visibility.
 *
 * Results are logged and returned as a SyncReport for the admin UI.
 */
import { listOrgMembers, type OrgMember } from './github.js';
import { db } from './db.js';

export interface SyncReport {
  matched: number;
  inGithubNotRoster: OrgMember[];  // in org but no roster entry
  inRosterNotGithub: { username: string; github_username: string }[]; // roster entry not in org
}

export async function syncGithub(): Promise<SyncReport> {
  console.log('[github-sync] fetching org members');
  const orgMembers = await listOrgMembers();
  console.log(`[github-sync] ${orgMembers.length} org members`);

  type RosterRow = { username: string; github_username: string };
  const { rows: rosterUsers } = await db.query<RosterRow>(
    `SELECT username, github_username FROM users WHERE github_username IS NOT NULL`,
  );

  const rosterByGithub = new Map(
    rosterUsers.map((u) => [u.github_username.toLowerCase(), u]),
  );
  const orgLogins = new Set(orgMembers.map((m) => m.login.toLowerCase()));

  let matched = 0;
  const inGithubNotRoster: OrgMember[] = [];

  for (const member of orgMembers) {
    if (rosterByGithub.has(member.login.toLowerCase())) {
      matched++;
    } else {
      inGithubNotRoster.push(member);
    }
  }

  const inRosterNotGithub = rosterUsers.filter(
    (u) => !orgLogins.has(u.github_username.toLowerCase()),
  );

  console.log(
    `[github-sync] done — ${matched} matched, ` +
    `${inGithubNotRoster.length} in org without roster entry, ` +
    `${inRosterNotGithub.length} roster entries not in org`,
  );

  if (inGithubNotRoster.length > 0) {
    console.warn(
      `[github-sync] in org but not in roster:`,
      inGithubNotRoster.map((m) => m.login).join(', '),
    );
  }
  if (inRosterNotGithub.length > 0) {
    console.warn(
      `[github-sync] in roster but not in org:`,
      inRosterNotGithub.map((u) => u.github_username).join(', '),
    );
  }

  return { matched, inGithubNotRoster, inRosterNotGithub };
}
