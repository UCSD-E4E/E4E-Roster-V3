import { db } from '../services/db';
import { projectMembershipGroupsSql } from '../services/project-membership';

export interface PersonStatus {
  kind: 'ready' | 'attention' | 'unverified' | 'blocked';
  label: string;
  rank: number;
  details: Array<{ label: string; message: string; checkedAt?: string }>;
}

/** Snapshot of recorded provider results, never a live API call on page load.
 * A named account includes its shared lifecycle even if an authorized system
 * administrator is visiting an organization they do not belong to.
 */
export async function getPersonStatuses(orgId?: number, username?: string): Promise<Map<string, PersonStatus>> {
  const args = [orgId ?? null, username ?? null];
  const [{ rows: people }, { rows: grants }] = await Promise.all([
    db.query<{ username: string; disabled: boolean; expired: boolean; expiry: string | null; project_assigned: boolean }>(`
      SELECT u.username, u.disabled, u.expiry_date < CURRENT_DATE AS expired,
        TO_CHAR(u.expiry_date,'YYYY-MM-DD') AS expiry,
        EXISTS (SELECT 1 FROM user_orgs o JOIN projects p ON p.org_id=o.org_id
          JOIN (${projectMembershipGroupsSql}) g ON g.project_id=p.id AND g.ldap_group=ANY(u.ldap_groups)
          WHERE o.username=u.username AND ($1::int IS NULL OR o.org_id=$1)) AS project_assigned
      FROM users u WHERE ($2::text IS NULL OR u.username=$2)
        AND ($1::int IS NULL OR $2::text IS NOT NULL OR EXISTS (SELECT 1 FROM user_orgs o WHERE o.username=u.username AND o.org_id=$1))`, args),
    db.query<{ username: string; org_id: number; org_name: string; service: string; target_id: string; target_name: string;
      external_id: string | null; pending: string | null; action: string | null; outcome: string | null; checked_at: string | null }>(`
      SELECT DISTINCT ON (u.username,o.org_id,m.service,m.target_id)
        u.username,o.org_id,org.name AS org_name,m.service,m.target_id,m.target_name,
        CASE WHEN m.service='github' THEN u.github_username ELSE x.external_id END AS external_id,
        CASE WHEN m.service='github' THEN u.github_username_pending END AS pending,
        a.action,a.details->>'outcome' AS outcome,a.created_at::text AS checked_at
      FROM users u JOIN user_orgs o ON o.username=u.username JOIN orgs org ON org.id=o.org_id
      JOIN group_mappings m ON m.org_id=o.org_id AND m.ldap_group=ANY(u.ldap_groups)
      JOIN org_groups g ON g.org_id=m.org_id AND g.ldap_group=m.ldap_group
      JOIN org_integrations i ON i.org_id=m.org_id AND i.service=m.service AND i.enabled
      LEFT JOIN integration_identities x ON x.org_id=o.org_id AND x.username=u.username AND x.service='slack'
      LEFT JOIN LATERAL (SELECT a.action,a.details,a.created_at FROM audit_log a
        WHERE a.org_id=o.org_id AND a.target_username=u.username
          AND a.action IN ('integration_grant','integration_grant_failed')
          AND a.details->>'service'=m.service AND a.details->>'targetId'=m.target_id
          AND a.details->>'externalId'=CASE WHEN m.service='github' THEN u.github_username ELSE x.external_id END
          AND a.created_at >= i.updated_at AND a.created_at >= m.created_at
        ORDER BY a.id DESC LIMIT 1) a ON TRUE
      WHERE ($1::int IS NULL OR o.org_id=$1) AND ($2::text IS NULL OR u.username=$2)
      ORDER BY u.username,o.org_id,m.service,m.target_id,m.created_at`, args),
  ]);
  const result = new Map<string, PersonStatus>();
  for (const person of people) {
    const details: PersonStatus['details'] = [{ label: 'Account', message: person.disabled ? 'Disabled' : person.expired ? `Expired ${person.expiry}` : person.expiry ? `Active through ${person.expiry}` : 'Active · no expiration' }];
    if (person.disabled && person.expired) details.push({ label: 'Expiration', message: `Expired ${person.expiry}` });
    let attention = false; let unverified = false;
    const required = grants.filter(g => g.username === person.username);
    for (const grant of required) {
      let message: string;
      if (grant.pending) { message = `GitHub username ${grant.pending} pending review`; attention = true; }
      else if (!grant.external_id) { message = 'Account not linked'; attention = true; }
      else if (grant.action === 'integration_grant_failed') { message = 'Last grant failed · review admin logs'; attention = true; }
      else if (grant.service === 'github' && grant.outcome === 'pending') { message = 'Invitation pending acceptance'; attention = true; }
      else if (grant.action === 'integration_grant' && (grant.service === 'github' ? grant.outcome === 'active' : ['invited','already_member'].includes(grant.outcome ?? ''))) message = 'Access confirmed at last sync';
      else { message = 'Access not verified · run integration sync'; unverified = true; }
      details.push({ label: `${orgId === undefined ? `${grant.org_name} · ` : ''}${grant.service === 'github' ? 'GitHub' : 'Slack'} · ${grant.target_name}`, message, checkedAt: !grant.pending && grant.external_id ? grant.checked_at ?? undefined : undefined });
    }
    if (!required.length) details.push({ label: 'Integrations', message: 'No integration grants required by current groups and enabled providers' });
    if (!person.project_assigned) details.push({ label: 'Projects', message: 'No project assigned' });
    const kind = person.disabled || person.expired ? 'blocked' : attention ? 'attention' : unverified ? 'unverified' : 'ready';
    result.set(person.username, { kind, label: person.disabled ? 'Disabled' : person.expired ? 'Expired' : kind === 'attention' ? 'Needs attention' : kind === 'unverified' ? 'Unverified' : 'Ready', rank: { blocked: 0, attention: 1, unverified: 2, ready: 3 }[kind], details });
  }
  return result;
}
