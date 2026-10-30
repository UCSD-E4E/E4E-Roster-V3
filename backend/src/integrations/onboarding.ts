import { createHash, randomBytes } from 'crypto';
import { db, ensureUserOrgMembership, getUserOrgMemberships } from '../services/db';
import { getUser } from '../services/ldap';
import { upsertDirectoryUser } from '../services/sync';
import type { AuthUser } from '../types/user';
import { connectionFor } from './config';
import { integrationAdapters } from './providers';
import { auditIntegration } from '../services/integrations';

export function rosterBaseUrl(): string {
  const url = new URL(process.env.ROSTER_BASE_URL ?? (process.env.ROSTER_HOST ? `https://${process.env.ROSTER_HOST}` : ''));
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('ROSTER_BASE_URL must be the roster origin.');
  if (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('A secure roster origin is required.');
  return url.origin;
}
export function onboardingTokenHash(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function personEditPath(orgSlug: string, username: string): string {
  return `/orgs/${encodeURIComponent(orgSlug)}/v2/people/${encodeURIComponent(username)}/edit`;
}

// Invites and lead notifications are deliberately at-most-once. A failed attempt is visible in
// settings; no background reminders or automatic retries can create duplicate messages.
export async function scanSlackOnboarding(orgId: number): Promise<{ invited: number; skipped: number; failed: number }> {
  const origin = rosterBaseUrl();
  const connection = await connectionFor(orgId, 'slack');
  if (connection.config.onboardingEnabled !== 'true' || !connection.config.onboardingChannelId) throw new Error('Configure onboarding and a roster bot channel first.');
  const lock = await db.connect();
  const result = { invited: 0, skipped: 0, failed: 0 };
  try {
    const { rows: [state] } = await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(734922,$1) AS locked', [orgId]);
    if (!state.locked) return result;
    try {
      const provider = integrationAdapters().slack(connection);
      const members = await provider.members();
      const { rows: roster } = await db.query<{ external_id: string | null; email: string | null; disabled: boolean; in_org: boolean }>(
        `SELECT x.external_id, u.email, u.disabled, EXISTS(SELECT 1 FROM user_orgs o WHERE o.org_id=$1 AND o.username=u.username) AS in_org
         FROM users u LEFT JOIN integration_identities x ON x.username=u.username AND x.org_id=$1 AND x.service='slack'`, [orgId]);
      const { rows: [org] } = await db.query<{ name: string }>('SELECT name FROM orgs WHERE id=$1', [orgId]);
      for (const member of members) {
        const email = member.email.trim().toLowerCase();
        // Existing organization members and disabled directory identities need no unsolicited messages.
        if (!email || roster.some(r => r.external_id === member.id || (r.email?.toLowerCase() === email && (r.in_org || r.disabled)))) { result.skipped++; continue; }
        const token = randomBytes(32).toString('hex');
        const { rowCount } = await db.query(`INSERT INTO slack_onboarding (org_id,team_id,slack_user_id,slack_email,token_hash,expires_at)
          VALUES ($1,$2,$3,$4,$5,NOW()+INTERVAL '7 days') ON CONFLICT (org_id,team_id,slack_user_id) DO NOTHING`,
          [orgId, connection.config.teamId, member.id, email, onboardingTokenHash(token)]);
        if (!rowCount) { result.skipped++; continue; }
        try {
          // Fail closed if a connection has been disabled or rebound during a long scan.
          const current = await connectionFor(orgId, 'slack');
          if (current.config.teamId !== connection.config.teamId || current.config.onboardingEnabled !== 'true') throw new Error('Connection changed.');
          await integrationAdapters().slack(current).directMessage(member.id,
            `Connect your Slack account to the ${org.name} roster. Sign in with your existing roster SSO account and enter your GitHub username: ${origin}/connect/slack/${token}\nThis link expires in 7 days. You will join as a regular member; project and group access is assigned separately. If the link expires, run /roster-connect for a new one.`);
          await db.query(`UPDATE slack_onboarding SET delivery_status='sent' WHERE token_hash=$1`, [onboardingTokenHash(token)]);
          result.invited++;
        } catch {
          await db.query(`UPDATE slack_onboarding SET delivery_status='failed' WHERE token_hash=$1`, [onboardingTokenHash(token)]);
          result.failed++;
        }
      }
      await db.query(`INSERT INTO slack_discovery (org_id,last_scan_at,next_scan_at) VALUES ($1,NOW(),NOW()+INTERVAL '7 days')
        ON CONFLICT (org_id) DO UPDATE SET last_scan_at=NOW(),next_scan_at=EXCLUDED.next_scan_at,last_error=NULL`, [orgId]);
      await auditIntegration(orgId, 'slack-discovery', 'integration_discovery', null, result);
      return result;
    } finally { await lock.query('SELECT pg_advisory_unlock(734922,$1)', [orgId]); }
  } finally { lock.release(); }
}

export async function runDueSlackOnboarding(): Promise<void> {
  const { rows } = await db.query<{ org_id: number }>(`SELECT i.org_id FROM org_integrations i LEFT JOIN slack_discovery s ON s.org_id=i.org_id
    WHERE i.service='slack' AND i.enabled AND i.config->>'onboardingEnabled'='true' AND (s.next_scan_at IS NULL OR s.next_scan_at<=NOW())`);
  for (const row of rows) {
    try { await scanSlackOnboarding(row.org_id); }
    catch {
      await db.query(`INSERT INTO slack_discovery (org_id,next_scan_at,last_error) VALUES ($1,NOW()+INTERVAL '1 day','Discovery failed; check configuration and provider permissions.')
        ON CONFLICT (org_id) DO UPDATE SET next_scan_at=EXCLUDED.next_scan_at,last_error=EXCLUDED.last_error`, [row.org_id]);
    }
  }
}

export async function userRequestedOnboarding(orgId: number, slackUserId: string, confirmationCode = ''): Promise<string> {
  if (confirmationCode.trim()) return confirmSlackOnboarding(orgId, slackUserId, confirmationCode);
  const origin = rosterBaseUrl(); const connection = await connectionFor(orgId, 'slack');
  // The weekly-discovery opt-in controls unsolicited invitations, not personal requests.
  const email = await integrationAdapters().slack(connection).memberEmail(slackUserId);
  if (!email) throw new Error('Your Slack account needs an email address before connecting.');
  const token = randomBytes(32).toString('hex');
  const { rowCount } = await db.query(`INSERT INTO slack_onboarding (org_id,team_id,slack_user_id,slack_email,token_hash,expires_at,delivery_status)
    VALUES ($1,$2,$3,$4,$5,NOW()+INTERVAL '7 days','user_requested')
    ON CONFLICT (org_id,team_id,slack_user_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,
      slack_email=EXCLUDED.slack_email,delivery_status='user_requested',
      confirmation_username=NULL,confirmation_code_hash=NULL,confirmation_expires_at=NULL,confirmed_at=NULL
    WHERE slack_onboarding.claimed_at IS NULL`, [orgId, connection.config.teamId, slackUserId, email, onboardingTokenHash(token)]);
  if (!rowCount) {
    // Explicit requests also surface a pending submission made before review notices existed.
    const { rows: [account] } = await db.query<{ username: string; github_username_pending: string }>(
      `SELECT u.username,u.github_username_pending FROM slack_onboarding s
       JOIN users u ON u.username=s.claimed_by JOIN user_orgs o ON o.username=u.username AND o.org_id=s.org_id
       WHERE s.org_id=$1 AND s.team_id=$2 AND s.slack_user_id=$3 AND s.claimed_at IS NOT NULL
         AND u.github_username_pending IS NOT NULL`, [orgId,connection.config.teamId,slackUserId]);
    if (account) await notifyGithubReview(orgId, account.username, account.github_username_pending);
    return 'Your Slack identity is already connected. Use /roster-check to see your account.';
  }
  return `Sign in to connect your roster account and submit your GitHub username: ${origin}/connect/slack/${token}`;
}

/** Called only with the workspace/user from Slack's authenticated command payload. */
export async function confirmSlackOnboarding(orgId: number, slackUserId: string, code: string): Promise<string> {
  const normalized = code.trim().toUpperCase();
  if (!/^[A-F0-9]{16}$/.test(normalized)) throw new Error('Enter /roster-connect followed by the confirmation code shown in your browser.');
  const connection = await connectionFor(orgId, 'slack');
  if (!await integrationAdapters().slack(connection).memberEmail(slackUserId)) throw new Error('Your Slack account is unavailable.');
  const { rows: [confirmed] } = await db.query<{ confirmation_username: string }>(`UPDATE slack_onboarding s
    SET confirmed_at=COALESCE(confirmed_at,NOW()) FROM org_integrations i
    WHERE s.org_id=$1 AND s.team_id=$2 AND s.slack_user_id=$3 AND s.confirmation_code_hash=$4
      AND s.claimed_at IS NULL AND s.expires_at>NOW() AND s.confirmation_expires_at>NOW()
      AND s.confirmation_username IS NOT NULL AND i.org_id=s.org_id AND i.service='slack'
      AND i.enabled AND i.config->>'teamId'=s.team_id
    RETURNING s.confirmation_username`, [orgId,connection.config.teamId,slackUserId,onboardingTokenHash(normalized)]);
  if (!confirmed) throw new Error('This confirmation code is expired or unavailable for your Slack account. Return to the browser and try again.');
  return `Slack ownership confirmed for roster account ${confirmed.confirmation_username}. Return to your browser and click Finish connection.`;
}

export async function onboardingDetails(hash: string) {
  const { rows } = await db.query<{ org_id: number; team_id: string; slack_user_id: string; slack_email: string; name: string; slug: string }>(
    `SELECT s.org_id,s.team_id,s.slack_user_id,s.slack_email,o.name,o.slug FROM slack_onboarding s JOIN orgs o ON o.id=s.org_id
     JOIN org_integrations i ON i.org_id=s.org_id AND i.service='slack' AND i.enabled AND i.config->>'teamId'=s.team_id
     WHERE s.token_hash=$1 AND s.expires_at>NOW() AND s.claimed_at IS NULL`, [hash]);
  if (!rows[0]) throw new Error('This connection link is expired, already used, or unavailable. Run /roster-connect in Slack for help.');
  return rows[0];
}

export async function completeSlackOnboarding(hash: string, user: AuthUser, githubUsername: string) {
  if (user.isLocalAdmin) throw new Error('Use your personal SSO account to connect Slack.');
  if (!/^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(githubUsername)) throw new Error('Enter a valid GitHub username, without a URL or @ prefix.');
  const invitation = await onboardingDetails(hash);
  const connection = await connectionFor(invitation.org_id, 'slack');
  const slackEmail = await integrationAdapters().slack(connection).memberEmail(invitation.slack_user_id);
  if (!slackEmail || slackEmail.toLowerCase() !== invitation.slack_email.toLowerCase()) throw new Error('Your Slack email has changed. Request a new connection link.');
  const { rows: existing } = await db.query<{ email: string | null; disabled: boolean }>('SELECT email,disabled FROM users WHERE username=$1', [user.username]);
  const directory = existing[0] ? null : await getUser(user.username);
  const profile = existing[0] ?? directory;
  if (!profile || profile.disabled) throw new Error('An active directory account is required. Contact a project lead if you need an account.');
  if (profile.email?.trim().toLowerCase() !== slackEmail.trim().toLowerCase()) {
    const { rows: [proof] } = await db.query(`SELECT 1 FROM slack_onboarding WHERE token_hash=$1
      AND confirmation_username=$2 AND confirmed_at IS NOT NULL AND confirmation_expires_at>NOW()`, [hash,user.username]);
    if (!proof) {
      const code = randomBytes(8).toString('hex').toUpperCase();
      const { rowCount } = await db.query(`UPDATE slack_onboarding SET confirmation_username=$2,confirmation_code_hash=$3,
        confirmation_expires_at=NOW()+INTERVAL '10 minutes',confirmed_at=NULL
        WHERE token_hash=$1 AND claimed_at IS NULL AND expires_at>NOW()`, [hash,user.username,onboardingTokenHash(code)]);
      if (!rowCount) throw new Error('This connection link was already used or expired.');
      return { confirmationRequired: true as const, confirmationCode: code, slackEmail, organization: invitation.name };
    }
  }
  const client = await db.connect(); let joined = false; let pendingGithubUsername: string | null = null;
  try {
    await client.query('BEGIN');
    const { rowCount: enabled } = await client.query(`SELECT 1 FROM org_integrations WHERE org_id=$1 AND service='slack'
      AND enabled AND config->>'teamId'=$2 FOR SHARE`, [invitation.org_id,invitation.team_id]);
    if (!enabled) throw new Error('This connection is no longer available.');
    // Single-use claim and identity uniqueness live in the same transaction as membership creation.
    const { rows: [valid] } = await client.query(`SELECT confirmation_username,confirmed_at,confirmation_expires_at>NOW() AS confirmation_valid FROM slack_onboarding WHERE token_hash=$1 AND claimed_at IS NULL AND expires_at>NOW() FOR UPDATE`, [hash]);
    if (!valid) throw new Error('This connection link was already used or expired.');
    if (directory) await upsertDirectoryUser(directory, client);
    const { rows: [account] } = await client.query<{ disabled: boolean; email: string }>('SELECT disabled,email FROM users WHERE username=$1 FOR UPDATE', [user.username]);
    if (account.disabled) throw new Error('Your account changed. Contact an administrator.');
    if (account.email?.trim().toLowerCase() !== slackEmail.trim().toLowerCase()
      && !(valid.confirmation_username === user.username && valid.confirmed_at && valid.confirmation_valid)) {
      throw new Error('Your Slack ownership confirmation is unavailable or expired. Submit the form again to get a new code.');
    }
    joined = await ensureUserOrgMembership(user.username, invitation.org_id, client);
    const { rows: links } = await client.query<{ username: string; external_id: string }>(`SELECT username,external_id FROM integration_identities
      WHERE org_id=$1 AND service='slack' AND (username=$2 OR external_id=$3)`, [invitation.org_id,user.username,invitation.slack_user_id]);
    if (links.some(link => link.username !== user.username || link.external_id !== invitation.slack_user_id)) throw new Error('A different Slack account is already linked. Contact an administrator.');
    await client.query(`INSERT INTO integration_identities (org_id,username,service,external_id) VALUES ($1,$2,'slack',$3) ON CONFLICT DO NOTHING`,
      [invitation.org_id,user.username,invitation.slack_user_id]);
    // Self-reported GitHub names are collected for review, not treated as proven ownership.
    const { rows: [submission] } = await client.query<{ github_username_pending: string | null }>(
      `UPDATE users SET github_username_pending=CASE WHEN LOWER(github_username)=LOWER($1) THEN NULL ELSE $1 END,updated_at=NOW()
       WHERE username=$2 RETURNING github_username_pending`, [githubUsername,user.username]);
    pendingGithubUsername = submission.github_username_pending;
    await client.query('UPDATE slack_onboarding SET claimed_by=$1,claimed_at=NOW() WHERE token_hash=$2', [user.username,hash]);
    await client.query(`INSERT INTO audit_log (org_id,actor,action,target_username,details) VALUES ($1,$2,'integration_onboarded',$2,$3)`,
      [invitation.org_id,user.username,JSON.stringify({ joined, slackUserId: invitation.slack_user_id, githubUsername, githubStatus: 'submitted',
        slackVerification: account.email?.trim().toLowerCase() === slackEmail.trim().toLowerCase() ? 'matching_email' : 'slack_command' })]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  // Refresh the signed-in user's membership list without changing role or group assignments.
  const memberships = await getUserOrgMemberships(user.username);
  user.orgs = memberships.map(row => ({ orgId: row.org_id, orgSlug: row.org_slug, orgName: row.org_name, role: row.role as 'member' | 'project_lead' | 'org_admin' }));
  if (joined) await notifyOrganizationJoin(invitation.org_id, user.username, pendingGithubUsername ?? undefined);
  else if (pendingGithubUsername) await notifyGithubReview(invitation.org_id, user.username, pendingGithubUsername);
  return { confirmationRequired: false as const, joined, organization: invitation.name, accountPath: `/orgs/${encodeURIComponent(invitation.slug)}/v2/account` };
}

async function sendOrganizationNotice(orgId: number, username: string, message: (orgName: string) => string): Promise<void> {
  const connection = await connectionFor(orgId, 'slack');
  if (!connection.config.onboardingChannelId) throw new Error('No roster bot channel.');
  const { rows: [org] } = await db.query<{ slug: string; name: string }>('SELECT slug,name FROM orgs WHERE id=$1', [orgId]);
  const editUrl = `${rosterBaseUrl()}${personEditPath(org.slug,username)}`;
  await integrationAdapters().slack(connection).sendMessage(connection.config.onboardingChannelId,
    `${message(org.name)} Edit user: ${editUrl}`);
}

async function reserveGithubReview(orgId: number, username: string, githubUsername: string): Promise<boolean> {
  // Only currently pending submissions qualify; case differences cannot create reminders.
  const { rowCount } = await db.query(`INSERT INTO github_review_notifications (org_id,username,github_username)
    SELECT o.org_id,u.username,LOWER(u.github_username_pending) FROM users u JOIN user_orgs o ON o.username=u.username
    WHERE o.org_id=$1 AND u.username=$2 AND LOWER(u.github_username_pending)=LOWER($3)
    ON CONFLICT DO NOTHING`, [orgId,username,githubUsername]);
  return Boolean(rowCount);
}

async function markGithubReview(orgId: number, username: string, githubUsername: string, status: 'sent' | 'failed'): Promise<void> {
  await db.query(`UPDATE github_review_notifications SET status=$4 WHERE org_id=$1 AND username=$2 AND github_username=LOWER($3)`,
    [orgId,username,githubUsername,status]);
}

function githubReviewMessage(githubUsername: string): string {
  return `GitHub username submitted for review: ${githubUsername}. A roster administrator should verify ownership, then save the GitHub username on Edit User to approve it.`;
}

export async function notifyOrganizationJoin(orgId: number, username: string, githubUsername?: string): Promise<void> {
  const { rowCount } = await db.query(`INSERT INTO org_join_notifications (org_id,username) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [orgId,username]);
  if (!rowCount) return;
  const review = githubUsername ? await reserveGithubReview(orgId, username, githubUsername) : false;
  try {
    await sendOrganizationNotice(orgId, username, orgName =>
      `A new regular member joined the ${orgName} roster: ${username}. Project leads: coordinate their project and group assignments with a roster administrator.${review ? ` ${githubReviewMessage(githubUsername!)}` : ''}`);
    await db.query(`UPDATE org_join_notifications SET status='sent' WHERE org_id=$1 AND username=$2`, [orgId,username]);
    if (review) await markGithubReview(orgId, username, githubUsername!, 'sent');
  } catch {
    await db.query(`UPDATE org_join_notifications SET status='failed' WHERE org_id=$1 AND username=$2`, [orgId,username]);
    if (review) await markGithubReview(orgId, username, githubUsername!, 'failed');
  }
}

export async function notifyGithubReview(orgId: number, username: string, githubUsername: string): Promise<void> {
  if (!await reserveGithubReview(orgId, username, githubUsername)) return;
  try {
    await sendOrganizationNotice(orgId, username, orgName =>
      `${username} submitted a GitHub account for the ${orgName} roster. ${githubReviewMessage(githubUsername)}`);
    await markGithubReview(orgId, username, githubUsername, 'sent');
  } catch {
    await markGithubReview(orgId, username, githubUsername, 'failed');
  }
}
