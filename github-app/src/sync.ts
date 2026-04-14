/**
 * Cross-references GitHub org members against the roster DB.
 *
 * Match strategy: github_username (case-insensitive login match).
 * Email is not used — GitHub users control their email visibility.
 *
 * Any roster user with a github_username not in the org is auto-invited.
 */
import { listOrgMembers, inviteToOrg, type OrgMember } from './github.js';
import { db } from './db.js';

export interface SyncReport {
  matched: number;
  inGithubNotRoster: OrgMember[];
  inRosterNotGithub: { username: string; github_username: string }[];
  invited: string[];
  inviteFailed: string[];
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

  // Auto-invite roster users not yet in the org
  const invited: string[] = [];
  const inviteFailed: string[] = [];

  for (const u of inRosterNotGithub) {
    const result = await ensureOrgMember(u.github_username);
    if (result === 'invited') {
      invited.push(u.github_username);
    } else if (result === 'failed') {
      inviteFailed.push(u.github_username);
    }
    // 'already_pending' — invitation already sent, nothing to do
  }

  if (invited.length > 0) {
    console.log(`[github-sync] invited ${invited.length} user(s): ${invited.join(', ')}`);
  }
  if (inviteFailed.length > 0) {
    console.warn(`[github-sync] failed to invite ${inviteFailed.length} user(s): ${inviteFailed.join(', ')}`);
  }

  return { matched, inGithubNotRoster, inRosterNotGithub, invited, inviteFailed };
}

/**
 * Invites a GitHub user to the org if they are not already a member or pending.
 * Returns 'invited', 'already_pending', or 'failed'.
 */
export async function ensureOrgMember(
  githubUsername: string,
): Promise<'invited' | 'already_pending' | 'failed'> {
  try {
    await inviteToOrg(githubUsername);
    console.log(`[github] invited ${githubUsername} to org`);
    return 'invited';
  } catch (err: unknown) {
    // GitHub returns 422 when an invitation already exists
    const status = (err as { status?: number })?.status;
    if (status === 422) {
      console.log(`[github] ${githubUsername} already has a pending invitation`);
      return 'already_pending';
    }
    console.error(`[github] failed to invite ${githubUsername}:`, err);
    return 'failed';
  }
}
