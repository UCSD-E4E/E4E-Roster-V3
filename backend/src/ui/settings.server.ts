import { db } from '../services/db';
import { data } from 'react-router';
import { encrypt } from '../services/crypto';
import * as ldap from '../services/ldap';
import { planIntegrationSync, runIntegrationSync, type IntegrationSyncResult } from '../services/integrations';
import { connectionFor } from '../integrations/config';
import { integrationAdapters, integrationFailure } from '../integrations/providers';
import { linkSlackIdentity } from '../integrations/slack-actions';
import { rosterBaseUrl, scanSlackOnboarding } from '../integrations/onboarding';
import { requireOrgAdmin } from './access';
import type { RosterUiContext } from './projects.server';

export interface IntegrationSummary {
  service: 'github' | 'slack';
  enabled: boolean;
  configured: boolean;
  detail: string;
}

export interface IntegrationSettings {
  github: { enabled: boolean; appId: string; installationId: string; org: string; hasPrivateKey: boolean; hasWebhookSecret: boolean };
  slack: { enabled: boolean; teamId: string; hasBotToken: boolean; hasAppToken: boolean; onboardingEnabled: boolean; onboardingChannelId: string };
}

export interface OrgGroupMappingSettings {
  groups: string[];
  projects: Array<{ id: number; name: string }>;
  selectedGroup: string | null;
  role: string | null;
  mappings: Array<{ id: number; service: string; targetId: string; targetName: string }>;
  lastSync: IntegrationSyncResult | null;
}

export async function listIntegrationSummaries(context: RosterUiContext): Promise<IntegrationSummary[]> {
  requireOrgAdmin(context);
  const { rows } = await db.query<{ service: 'github' | 'slack'; enabled: boolean; config: Record<string, string> }>(
    `SELECT service, enabled, config
     FROM org_integrations
     WHERE org_id = $1 AND service = ANY($2::text[])`,
    [context.org.id, ['github', 'slack']],
  );
  const byService = new Map(rows.map((row) => [row.service, row]));

  return (['github', 'slack'] as const).map((service) => {
    const row = byService.get(service);
    const configured = service === 'github'
      ? Boolean(row?.config.appId && row?.config.installationId && row?.config.org && row?.config.privateKey)
      : Boolean(row?.config.teamId && row?.config.botToken);
    const detail = service === 'github'
      ? (row?.config.org ? `GitHub organization: ${row.config.org}` : 'No GitHub organization configured')
      : (row?.config.teamId ? `Slack workspace ID: ${row.config.teamId}` : 'No Slack workspace configured');
    return { service, enabled: row?.enabled ?? false, configured, detail };
  });
}

export async function getIntegrationSettings(context: RosterUiContext): Promise<IntegrationSettings> {
  requireOrgAdmin(context);
  const { rows } = await db.query<{ service: 'github' | 'slack'; enabled: boolean; config: Record<string, string> }>(
    `SELECT service, enabled, config FROM org_integrations
     WHERE org_id = $1 AND service = ANY($2::text[])`,
    [context.org.id, ['github', 'slack']],
  );
  const byService = new Map(rows.map((row) => [row.service, row]));
  const github = byService.get('github');
  const slack = byService.get('slack');
  return {
    github: { enabled: github?.enabled ?? false, appId: github?.config.appId ?? '', installationId: github?.config.installationId ?? '', org: github?.config.org ?? '', hasPrivateKey: Boolean(github?.config.privateKey), hasWebhookSecret: Boolean(github?.config.webhookSecret) },
    slack: { enabled: slack?.enabled ?? false, teamId: slack?.config.teamId ?? '', hasBotToken: Boolean(slack?.config.botToken), hasAppToken: Boolean(slack?.config.appToken), onboardingEnabled: slack?.config.onboardingEnabled === 'true', onboardingChannelId: slack?.config.onboardingChannelId ?? '' },
  };
}

export async function updateGithubSettings(context: RosterUiContext, fields: { enabled: boolean; appId: string; installationId: string; org: string; privateKey: string; webhookSecret?: string }): Promise<void> {
  requireOrgAdmin(context);
  const existing = await getIntegrationSettings(context);
  const config: Record<string, string> = { appId: fields.appId, installationId: fields.installationId, org: fields.org };
  if (fields.privateKey) config.privateKey = encrypt(fields.privateKey);
  else if (existing.github.hasPrivateKey) {
    const { rows } = await db.query<{ config: Record<string, string> }>('SELECT config FROM org_integrations WHERE org_id = $1 AND service = $2', [context.org.id, 'github']);
    config.privateKey = rows[0]?.config.privateKey;
  }
  await preserveSecret(context.org.id, 'github', config, 'webhookSecret', fields.webhookSecret);
  await rejectDuplicateConnection(context.org.id, 'github', 'org', fields.org, fields.enabled);
  await db.query(`INSERT INTO org_integrations (org_id, service, config, enabled) VALUES ($1, 'github', $2, $3)
    ON CONFLICT (org_id, service) DO UPDATE SET config = $2, enabled = $3, updated_at = NOW()`, [context.org.id, JSON.stringify(config), fields.enabled]);
}

export async function updateSlackSettings(context: RosterUiContext, fields: { enabled: boolean; teamId: string; botToken: string; appToken?: string; onboardingEnabled?: boolean; onboardingChannelId?: string }): Promise<void> {
  requireOrgAdmin(context);
  const existing = await getIntegrationSettings(context);
  const config: Record<string, string> = { teamId: fields.teamId };
  const onboardingEnabled = fields.onboardingEnabled ?? existing.slack.onboardingEnabled;
  const onboardingChannelId = fields.onboardingChannelId ?? existing.slack.onboardingChannelId;
  if (onboardingChannelId && !/^[CG][A-Z0-9]+$/.test(onboardingChannelId)) throw data('Enter the roster bot channel ID, not its name.', { status: 400 });
  if (onboardingEnabled) {
    if (!onboardingChannelId) throw data('Choose a roster bot channel before enabling onboarding.', { status: 400 });
    try { rosterBaseUrl(); } catch { throw data('Configure ROSTER_BASE_URL before enabling onboarding.', { status: 400 }); }
    config.onboardingEnabled = 'true';
  }
  if (onboardingChannelId) config.onboardingChannelId = onboardingChannelId;
  if (fields.botToken) config.botToken = encrypt(fields.botToken);
  else if (existing.slack.hasBotToken) {
    const { rows } = await db.query<{ config: Record<string, string> }>('SELECT config FROM org_integrations WHERE org_id = $1 AND service = $2', [context.org.id, 'slack']);
    config.botToken = rows[0]?.config.botToken;
  }
  await preserveSecret(context.org.id, 'slack', config, 'appToken', fields.appToken);
  await rejectDuplicateConnection(context.org.id, 'slack', 'teamId', fields.teamId, fields.enabled);
  await db.query(`INSERT INTO org_integrations (org_id, service, config, enabled) VALUES ($1, 'slack', $2, $3)
    ON CONFLICT (org_id, service) DO UPDATE SET config = $2, enabled = $3, updated_at = NOW()`, [context.org.id, JSON.stringify(config), fields.enabled]);
}

export async function getOrgGroupMappingSettings(context: RosterUiContext, selectedGroup: string | null): Promise<OrgGroupMappingSettings> {
  requireOrgAdmin(context);
  const [{ rows: groupRows }, { rows: projectRows }] = await Promise.all([
    db.query<{ ldap_group: string }>('SELECT ldap_group FROM org_groups WHERE org_id = $1 ORDER BY ldap_group', [context.org.id]),
    db.query<{ id: number; name: string }>('SELECT id, name FROM projects WHERE org_id = $1 ORDER BY name', [context.org.id]),
  ]);
  const groups = groupRows.map((row) => row.ldap_group); const selected = selectedGroup && groups.includes(selectedGroup) ? selectedGroup : null;
  if (!selected) return { groups, projects: projectRows, selectedGroup: null, role: null, mappings: [], lastSync: null };
  const [{ rows: mappings }, { rows: roles }] = await Promise.all([
    db.query<{ id: number; service: string; target_id: string; target_name: string }>('SELECT id, service, target_id, target_name FROM group_mappings WHERE org_id = $1 AND ldap_group = $2 ORDER BY service, target_name', [context.org.id, selected]),
    db.query<{ role: string }>('SELECT role FROM org_ldap_group_mappings WHERE org_id = $1 AND ldap_group = $2', [context.org.id, selected]),
  ]);
  return { groups, projects: projectRows, selectedGroup: selected, role: roles[0]?.role ?? null, mappings: mappings.map((mapping) => ({ id: mapping.id, service: mapping.service, targetId: mapping.target_id, targetName: mapping.target_name })), lastSync: null };
}

export async function createOrganizationGroup(context: RosterUiContext, fields: { name: string; projectId: string }): Promise<string> {
  requireOrgAdmin(context);
  const name = fields.name.trim();
  if (!name) throw data('Group name is required.', { status: 400 });
  const projectId = fields.projectId ? Number(fields.projectId) : null;
  if (fields.projectId && !Number.isInteger(projectId)) throw data('Invalid project.', { status: 400 });
  if (projectId !== null) {
    const { rowCount } = await db.query('SELECT 1 FROM projects WHERE id = $1 AND org_id = $2', [projectId, context.org.id]);
    if ((rowCount ?? 0) === 0) throw data('Project does not belong to this organization.', { status: 400 });
  }
  const result = await ldap.createGroup(name);
  if (result.status === 'failed') throw data(result.message, { status: 400 });
  await db.query('INSERT INTO org_groups (org_id, ldap_group) VALUES ($1, $2) ON CONFLICT DO NOTHING', [context.org.id, name]);
  if (projectId !== null) await db.query('INSERT INTO project_ldap_groups (project_id, ldap_group) VALUES ($1, $2) ON CONFLICT DO NOTHING', [projectId, name]);
  await db.query('INSERT INTO audit_log (actor, action, details, org_id) VALUES ($1, $2, $3, $4)', [context.user.username, 'create_ldap_group', JSON.stringify({ groupName: name, alreadyExisted: result.status === 'already_exists' }), context.org.id]);
  return name;
}

export async function syncOrganizationIntegrations(context: RosterUiContext): Promise<IntegrationSyncResult> {
  requireOrgAdmin(context);
  return runIntegrationSync(context.org.id, context.user.username);
}

const allowedMappingRoles = new Set(['member', 'project_lead', 'org_admin', 'utility']);

export async function setOrgGroupRole(context: RosterUiContext, ldapGroup: string, role: string): Promise<void> {
  requireOrgAdmin(context); if (!ldapGroup || !allowedMappingRoles.has(role) && role !== '') throw data('Invalid group role.', { status: 400 });
  const { rowCount } = await db.query('SELECT 1 FROM org_groups WHERE org_id = $1 AND ldap_group = $2', [context.org.id, ldapGroup]); if ((rowCount ?? 0) === 0) throw data('LDAP group does not belong to this organization.', { status: 400 });
  if (!role) await db.query('DELETE FROM org_ldap_group_mappings WHERE org_id = $1 AND ldap_group = $2', [context.org.id, ldapGroup]);
  else await db.query(`INSERT INTO org_ldap_group_mappings (org_id, ldap_group, role) VALUES ($1, $2, $3) ON CONFLICT (org_id, ldap_group) DO UPDATE SET role = EXCLUDED.role`, [context.org.id, ldapGroup, role]);
}

export async function addOrgGroupIntegrationMapping(context: RosterUiContext, fields: { ldapGroup: string; service: string; targetId: string; targetName: string }): Promise<void> {
  requireOrgAdmin(context); if (!['github', 'slack'].includes(fields.service) || !fields.ldapGroup || !fields.targetId.trim() || !fields.targetName.trim()) throw data('Group, service, target ID, and target name are required.', { status: 400 });
  const { rowCount } = await db.query('SELECT 1 FROM org_groups WHERE org_id = $1 AND ldap_group = $2', [context.org.id, fields.ldapGroup]); if ((rowCount ?? 0) === 0) throw data('LDAP group does not belong to this organization.', { status: 400 });
  await db.query('INSERT INTO group_mappings (ldap_group, service, target_id, target_name, org_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [fields.ldapGroup, fields.service, fields.targetId.trim(), fields.targetName.trim(), context.org.id]);
}

export async function removeOrgGroupIntegrationMapping(context: RosterUiContext, id: number): Promise<void> {
  requireOrgAdmin(context); if (!Number.isInteger(id)) throw data('Invalid integration mapping.', { status: 400 });
  await db.query('DELETE FROM group_mappings WHERE id = $1 AND org_id = $2', [id, context.org.id]);
}

async function preserveSecret(orgId: number, service: string, config: Record<string, string>, key: string, value?: string): Promise<void> {
  if (value) config[key] = encrypt(value);
  else {
    const { rows } = await db.query<{ config: Record<string, string> }>('SELECT config FROM org_integrations WHERE org_id=$1 AND service=$2', [orgId, service]);
    if (rows[0]?.config[key]) config[key] = rows[0].config[key];
  }
}
async function rejectDuplicateConnection(orgId: number, service: string, key: string, value: string, enabled: boolean): Promise<void> {
  if (!enabled || !value) return;
  const { rowCount } = await db.query(`SELECT 1 FROM org_integrations WHERE org_id<>$1 AND service=$2 AND enabled AND LOWER(config->>$3)=LOWER($4)`, [orgId, service, key, value]);
  if (rowCount) throw data('That workspace or GitHub organization is already connected to another roster organization.', { status: 400 });
}
export async function getIntegrationWorkbench(context: RosterUiContext) {
  requireOrgAdmin(context);
  const [plan, { rows: identities }, { rows: events }, { rows: deliveries }] = await Promise.all([
    planIntegrationSync(context.org.id),
    db.query<{ username: string; external_id: string | null }>(`SELECT o.username, x.external_id FROM user_orgs o
      LEFT JOIN integration_identities x ON x.org_id=o.org_id AND x.username=o.username AND x.service='slack'
      WHERE o.org_id=$1 ORDER BY o.username`, [context.org.id]),
    db.query<{ action: string; target_username: string | null; details: Record<string, string>; created_at: string }>(`SELECT action, target_username, details, created_at::text FROM audit_log
      WHERE org_id=$1 AND (action LIKE 'integration_%' OR action IN ('self_extend_account','link_slack_identity','github_webhook_received')) ORDER BY id DESC LIMIT 20`, [context.org.id]),
    db.query<{ kind: string; identity: string; status: string }>(`SELECT 'Invitation' AS kind,slack_user_id AS identity,delivery_status AS status FROM slack_onboarding WHERE org_id=$1
      UNION ALL SELECT 'Join notification',username,status FROM org_join_notifications WHERE org_id=$1`, [context.org.id]),
  ]);
  return { plan, identities, events, deliveries };
}
export type IntegrationWorkbench = Awaited<ReturnType<typeof getIntegrationWorkbench>>;
export async function integrationTool(context: RosterUiContext, fields: { intent: string; service: string; username: string; externalId: string }) {
  requireOrgAdmin(context);
  try {
    if (fields.intent === 'scan-slack') {
      const result = await scanSlackOnboarding(context.org.id);
      return { integrationMessage: `Slack scan: ${result.invited} invitations, ${result.skipped} skipped, ${result.failed} failed. No reminders are sent.` };
    }
    if (fields.intent === 'link-slack') {
      await linkSlackIdentity(context.org.id, fields.username, fields.externalId.trim(), context.user.username);
      return { integrationMessage: 'Slack identity linked for this organization.' };
    }
    if (fields.intent === 'sync') {
      const result = await runIntegrationSync(context.org.id, context.user.username);
      return { integrationMessage: `Completed: ${result.githubOps} GitHub operations, ${result.slackOps} Slack operations, ${result.errors} failures. Review the activity below.` };
    }
    if (fields.service !== 'slack' && fields.service !== 'github') throw new Error('Select Slack or GitHub.');
    const connection = await connectionFor(context.org.id, fields.service);
    const provider = fields.service === 'slack' ? integrationAdapters().slack(connection) : integrationAdapters().github(connection);
    const destinations = await provider.destinations();
    return { integrationMessage: `${fields.service} connection verified. ${destinations.length} destinations found.`, destinations };
  } catch (error) {
    // Provider errors can contain tokens. Only application-owned messages are safe to show.
    throw data(fields.intent === 'link-slack' ? 'Unable to link this Slack ID. Check organization membership, ID uniqueness, and the Slack connection.' :
      integrationFailure(error), { status: 400 });
  }
}
