import { db } from './db';
import { connectionFor, requireOrgId, Service } from '../integrations/config';
import { integrationAdapters, integrationFailure } from '../integrations/providers';

export interface PlannedGrant { service: Service; username: string; externalId: string; targetId: string }
export interface IntegrationPlan { grants: PlannedGrant[]; skipped: Array<{ username: string; reason: string }> }
export interface IntegrationSyncResult { githubOps: number; slackOps: number; errors: number }

export async function planIntegrationSync(orgId: number, onlyUsername?: string): Promise<IntegrationPlan> {
  requireOrgId(orgId);
  const [{ rows: mappings }, { rows: users }] = await Promise.all([
    db.query<{ service: Service; ldap_group: string; target_id: string }>(
      `SELECT m.service, m.ldap_group, m.target_id FROM group_mappings m
       JOIN org_groups g ON g.org_id=m.org_id AND g.ldap_group=m.ldap_group
       JOIN org_integrations i ON i.org_id=m.org_id AND i.service=m.service AND i.enabled
       WHERE m.org_id=$1`, [orgId]),
    db.query<{ username: string; github_username: string | null; slack_id: string | null; ldap_groups: string[]; disabled: boolean; expired: boolean }>(
      `SELECT u.username, u.github_username, x.external_id AS slack_id, u.ldap_groups, u.disabled,
       (u.expiry_date IS NOT NULL AND u.expiry_date < CURRENT_DATE) AS expired
       FROM users u JOIN user_orgs o ON o.username=u.username AND o.org_id=$1
       LEFT JOIN integration_identities x ON x.username=u.username AND x.org_id=o.org_id AND x.service='slack'
       WHERE ($2::text IS NULL OR u.username=$2) ORDER BY u.username`, [orgId, onlyUsername ?? null]),
  ]);
  const grants: PlannedGrant[] = []; const skipped: IntegrationPlan['skipped'] = []; const seen = new Set<string>();
  for (const user of users) {
    if (user.disabled || user.expired) { skipped.push({ username: user.username, reason: user.disabled ? 'Account disabled' : 'Account expired' }); continue; }
    for (const mapping of mappings) {
      if (!user.ldap_groups.includes(mapping.ldap_group)) continue;
      const externalId = mapping.service === 'github' ? user.github_username : user.slack_id;
      if (!externalId) { skipped.push({ username: user.username, reason: `Missing ${mapping.service} identity` }); continue; }
      const key = JSON.stringify([mapping.service, externalId, mapping.target_id]);
      if (!seen.has(key)) { grants.push({ service: mapping.service, username: user.username, externalId, targetId: mapping.target_id }); seen.add(key); }
    }
  }
  return { grants, skipped };
}

export async function auditIntegration(orgId: number, actor: string, action: string, username: string | null, details: unknown): Promise<void> {
  await db.query(`INSERT INTO audit_log (org_id, actor, action, target_username, details) VALUES ($1,$2,$3,$4,$5)`,
    [orgId, actor, action, username, JSON.stringify(details)]);
}

// Serialize grant execution within an organization across processes.
export async function runIntegrationSync(orgId: number, actor = 'integration-sync', onlyUsername?: string): Promise<IntegrationSyncResult> {
  requireOrgId(orgId);
  const lock = await db.connect();
  try {
    const { rows } = await lock.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(734921, $1) AS locked', [orgId]);
    if (!rows[0].locked) throw new Error('An integration sync is already running for this organization.');
    try {
      const plan = await planIntegrationSync(orgId, onlyUsername);
      const result = { githubOps: 0, slackOps: 0, errors: 0 };
      const adapters = integrationAdapters();
      for (const grant of plan.grants) {
        try {
          const current = await planIntegrationSync(orgId, grant.username);
          if (!current.grants.some(g => g.service === grant.service && g.targetId === grant.targetId && g.externalId === grant.externalId)) continue;
          // Re-read enabled state/credentials before each external effect.
          const connection = await connectionFor(orgId, grant.service);
          const provider = grant.service === 'github' ? adapters.github(connection) : adapters.slack(connection);
          const outcome = await provider.grant(grant.targetId, grant.externalId);
          await auditIntegration(orgId, actor, 'integration_grant', grant.username, { ...grant, outcome });
          if (grant.service === 'github') result.githubOps++; else result.slackOps++;
        } catch (error) {
          result.errors++;
          await auditIntegration(orgId, actor, 'integration_grant_failed', grant.username,
            { ...grant, error: integrationFailure(error) });
        }
      }
      return result;
    } finally { await lock.query('SELECT pg_advisory_unlock(734921, $1)', [orgId]); }
  } finally { lock.release(); }
}

// Preserve callers while replacing unconditional organization invitations with group-based grants.
export function triggerUserIntegrationSync(username: string, orgId: number | undefined, context = 'roster'): void {
  void reconcileUserIdentity(username, orgId, context).catch(() => console.warn(`[${context}] Integration reconciliation failed; review organization integration settings.`));
}

async function reconcileUserIdentity(username: string, orgId: number | undefined, actor: string): Promise<void> {
  const { rows } = await db.query<{ username: string; org_id: number }>(
    `SELECT u.username, o.org_id FROM users u JOIN user_orgs o ON o.username=u.username
     WHERE u.username=$1 AND ($2::integer IS NULL OR o.org_id=$2)`, [username, orgId ?? null]);
  for (const row of rows) await runIntegrationSync(row.org_id, actor, row.username);
}
