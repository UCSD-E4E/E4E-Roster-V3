import { db } from '../services/db';
import * as ldap from '../services/ldap';
import { connectionFor, resolveConnection } from './config';
import { integrationAdapters } from './providers';
import { auditIntegration } from '../services/integrations';

export async function linkSlackIdentity(orgId: number, username: string, externalId: string, actor: string): Promise<void> {
  if (!/^[UW][A-Z0-9]+$/.test(externalId)) throw new Error('Enter a stable Slack member ID (U… or W…), not a display name.');
  const { rowCount } = await db.query('SELECT 1 FROM user_orgs WHERE org_id=$1 AND username=$2', [orgId, username]);
  if (!rowCount) throw new Error('Person does not belong to this organization.');
  const connection = await connectionFor(orgId, 'slack');
  await integrationAdapters().slack(connection).memberEmail(externalId);
  await db.query(`INSERT INTO integration_identities (org_id, username, service, external_id) VALUES ($1,$2,'slack',$3)
    ON CONFLICT (org_id, username, service) DO UPDATE SET external_id=EXCLUDED.external_id`, [orgId, username, externalId]);
  await auditIntegration(orgId, actor, 'link_slack_identity', username, { externalId });
}

async function identify(teamId: string, userId: string): Promise<{ orgId: number; username: string }> {
  const connection = await resolveConnection('slack', 'teamId', teamId);
  const { rows } = await db.query<{ username: string }>(`SELECT username FROM integration_identities
    WHERE org_id=$1 AND service='slack' AND external_id=$2`, [connection.orgId, userId]);
  if (rows[0]) return { orgId: connection.orgId, username: rows[0].username };
  // First use can link a unique institutional email reported by the authenticated Slack API.
  const email = await integrationAdapters().slack(connection).memberEmail(userId);
  const { rows: candidates } = await db.query<{ username: string }>(`SELECT u.username FROM users u
    JOIN user_orgs o ON o.username=u.username AND o.org_id=$1 WHERE LOWER(u.email)=$2 AND NOT u.disabled`, [connection.orgId, email]);
  if (candidates.length !== 1) throw new Error('Your Slack account is not linked. Ask this organization’s roster administrator to link your Slack member ID.');
  await linkSlackIdentity(connection.orgId, candidates[0].username, userId, `slack:${userId}`);
  return { orgId: connection.orgId, username: candidates[0].username };
}

export async function handleSlackCommand(teamId: string, userId: string, command: string): Promise<string> {
  if (!['/roster-check', '/roster-extend'].includes(command)) throw new Error('Unknown roster command.');
  const { orgId, username } = await identify(teamId, userId);
  if (command === '/roster-extend') return extendAccount(orgId, username, `slack:${userId}`);
  const { rows } = await db.query<{ username: string; expiry: string | null; disabled: boolean; github_username: string | null; name: string; groups: string[] }>(
    `SELECT u.username, TO_CHAR(u.expiry_date,'YYYY-MM-DD') AS expiry, u.disabled, u.github_username, o.name,
     ARRAY(SELECT g.ldap_group FROM org_groups g WHERE g.org_id=$1 AND g.ldap_group=ANY(u.ldap_groups)) AS groups
     FROM users u JOIN user_orgs m ON m.username=u.username AND m.org_id=$1 JOIN orgs o ON o.id=m.org_id WHERE u.username=$2`, [orgId, username]);
  if (!rows[0] || rows[0].disabled) throw new Error('Account is unavailable or disabled. Contact a roster administrator.');
  const user = rows[0];
  return `${user.name} roster: ${user.username}\nShared account expires: ${user.expiry ?? 'No expiration'}\nGitHub: ${user.github_username ?? 'Not linked'}\nOrganization groups: ${user.groups.join(', ') || 'None'}`;
}

export async function extendAccount(orgId: number, username: string, actor: string): Promise<string> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ expiry: string | null; new_expiry: string; disabled: boolean }>(
      `SELECT TO_CHAR(u.expiry_date,'YYYY-MM-DD') AS expiry, TO_CHAR(CURRENT_DATE+90,'YYYY-MM-DD') AS new_expiry, u.disabled
       FROM users u JOIN user_orgs o ON o.username=u.username AND o.org_id=$1 WHERE u.username=$2 FOR UPDATE OF u`, [orgId, username]);
    const user = rows[0];
    if (!user || user.disabled) throw new Error('Account is unavailable or disabled. Contact a roster administrator.');
    if (!user.expiry || user.expiry >= user.new_expiry) {
      await client.query('COMMIT');
      return user.expiry ? `Your shared account is already valid through ${user.expiry}.` : 'Your shared account has no expiration.';
    }
    const result = await ldap.updateUserExpiry(username, user.new_expiry);
    if (result.status === 'failed') throw new Error('The directory rejected the extension. Your roster expiration has not changed.');
    await client.query('UPDATE users SET expiry_date=$1, updated_at=NOW() WHERE username=$2', [user.new_expiry, username]);
    await client.query(`INSERT INTO audit_log (org_id, actor, action, target_username, details) VALUES ($1,$2,'self_extend_account',$3,$4)`,
      [orgId, actor, username, JSON.stringify({ previousExpiry: user.expiry, expiry: user.new_expiry, scope: 'shared-account' })]);
    await client.query('COMMIT');
    return `Your shared account is now valid through ${user.new_expiry}. This applies across your roster organizations.`;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
