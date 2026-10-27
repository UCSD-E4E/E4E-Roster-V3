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

export async function userRequestedOnboarding(orgId: number, slackUserId: string): Promise<string> {
  const origin = rosterBaseUrl(); const connection = await connectionFor(orgId, 'slack');
  // The weekly-discovery opt-in controls unsolicited invitations, not personal requests.
  const email = await integrationAdapters().slack(connection).memberEmail(slackUserId);
  if (!email) throw new Error('Your Slack account needs an email address before connecting.');
  const token = randomBytes(32).toString('hex');
  const { rowCount } = await db.query(`INSERT INTO slack_onboarding (org_id,team_id,slack_user_id,slack_email,token_hash,expires_at,delivery_status)
    VALUES ($1,$2,$3,$4,$5,NOW()+INTERVAL '7 days','user_requested')
    ON CONFLICT (org_id,team_id,slack_user_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,
      slack_email=EXCLUDED.slack_email,delivery_status='user_requested'
    WHERE slack_onboarding.claimed_at IS NULL`, [orgId, connection.config.teamId, slackUserId, email, onboardingTokenHash(token)]);
  if (!rowCount) return 'Your Slack identity is already connected. Use /roster-check to see your account.';
  return `Sign in to connect your roster account and submit your GitHub username: ${origin}/connect/slack/${token}`;
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
  if (profile.email?.trim().toLowerCase() !== slackEmail.trim().toLowerCase()) throw new Error('Your roster and Slack email addresses differ. Ask an organization administrator to link your Slack identity.');
  const client = await db.connect(); let joined = false;
  try {
    await client.query('BEGIN');
    const { rowCount: enabled } = await client.query(`SELECT 1 FROM org_integrations WHERE org_id=$1 AND service='slack'
      AND enabled AND config->>'teamId'=$2 FOR SHARE`, [invitation.org_id,invitation.team_id]);
    if (!enabled) throw new Error('This connection is no longer available.');
    // Single-use claim and identity uniqueness live in the same transaction as membership creation.
    const { rows: [valid] } = await client.query(`SELECT 1 FROM slack_onboarding WHERE token_hash=$1 AND claimed_at IS NULL AND expires_at>NOW() FOR UPDATE`, [hash]);
    if (!valid) throw new Error('This connection link was already used or expired.');
    if (directory) await upsertDirectoryUser(directory, client);
    const { rows: [account] } = await client.query<{ disabled: boolean; email: string }>('SELECT disabled,email FROM users WHERE username=$1 FOR UPDATE', [user.username]);
    if (account.disabled || account.email?.trim().toLowerCase() !== slackEmail.trim().toLowerCase()) throw new Error('Your account changed. Contact an administrator.');
    joined = await ensureUserOrgMembership(user.username, invitation.org_id, client);
    const { rows: links } = await client.query<{ username: string; external_id: string }>(`SELECT username,external_id FROM integration_identities
      WHERE org_id=$1 AND service='slack' AND (username=$2 OR external_id=$3)`, [invitation.org_id,user.username,invitation.slack_user_id]);
    if (links.some(link => link.username !== user.username || link.external_id !== invitation.slack_user_id)) throw new Error('A different Slack account is already linked. Contact an administrator.');
    await client.query(`INSERT INTO integration_identities (org_id,username,service,external_id) VALUES ($1,$2,'slack',$3) ON CONFLICT DO NOTHING`,
      [invitation.org_id,user.username,invitation.slack_user_id]);
    // Self-reported GitHub names are collected for review, not treated as proven ownership.
    await client.query(`UPDATE users SET github_username_pending=CASE WHEN LOWER(github_username)=LOWER($1) THEN NULL ELSE $1 END,updated_at=NOW() WHERE username=$2`, [githubUsername,user.username]);
    await client.query('UPDATE slack_onboarding SET claimed_by=$1,claimed_at=NOW() WHERE token_hash=$2', [user.username,hash]);
    await client.query(`INSERT INTO audit_log (org_id,actor,action,target_username,details) VALUES ($1,$2,'integration_onboarded',$2,$3)`,
      [invitation.org_id,user.username,JSON.stringify({ joined, slackUserId: invitation.slack_user_id, githubUsername, githubStatus: 'submitted' })]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
  // Refresh the signed-in user's membership list without changing role or group assignments.
  const memberships = await getUserOrgMemberships(user.username);
  user.orgs = memberships.map(row => ({ orgId: row.org_id, orgSlug: row.org_slug, orgName: row.org_name, role: row.role as 'member' | 'project_lead' | 'org_admin' }));
  if (joined) await notifyOrganizationJoin(invitation.org_id, user.username);
  return { joined, organization: invitation.name, accountPath: `/orgs/${encodeURIComponent(invitation.slug)}/v2/account` };
}

export async function notifyOrganizationJoin(orgId: number, username: string): Promise<void> {
  const { rowCount } = await db.query(`INSERT INTO org_join_notifications (org_id,username) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [orgId,username]);
  if (!rowCount) return;
  try {
    const connection = await connectionFor(orgId, 'slack');
    if (!connection.config.onboardingChannelId) throw new Error('No roster bot channel.');
    const { rows: [org] } = await db.query<{ slug: string; name: string }>('SELECT slug,name FROM orgs WHERE id=$1', [orgId]);
    const editUrl = `${rosterBaseUrl()}${personEditPath(org.slug,username)}`;
    await integrationAdapters().slack(connection).sendMessage(connection.config.onboardingChannelId,
      `A new regular member joined the ${org.name} roster: ${username}. Project leads: coordinate their project and group assignments with a roster administrator. Edit user: ${editUrl}`);
    await db.query(`UPDATE org_join_notifications SET status='sent' WHERE org_id=$1 AND username=$2`, [orgId,username]);
  } catch {
    await db.query(`UPDATE org_join_notifications SET status='failed' WHERE org_id=$1 AND username=$2`, [orgId,username]);
  }
}
