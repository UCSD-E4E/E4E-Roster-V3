import bcrypt from 'bcryptjs';
import { data } from 'react-router';
import { db } from '../services/db';
import * as ldap from '../services/ldap';
import { triggerGithubInvite } from '../services/integrations';
import { syncUsers } from '../services/sync';
import type { NewUser } from '../services/types';
import type { AuthUser } from '../types/user';

export interface SystemUiContext {
  user: AuthUser;
  basePath: string;
}

export interface LocalAdminSummary {
  id: number;
  username: string;
  enabled: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface SystemOrganization {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  themeColor: string | null;
  memberCount: number;
}

export interface SystemAuditEntry {
  id: number;
  actor: string;
  action: string;
  targetUsername: string | null;
  details: unknown | null;
  createdAt: string;
  orgName: string | null;
  orgSlug: string | null;
}

export interface SystemUserSummary {
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
  disabled: boolean;
  ldapGroups: string[];
}

export interface SystemLdapMapping {
  id: number;
  ldapGroup: string;
  role: 'member' | 'project_lead' | 'org_admin' | 'utility';
}

export interface SystemLdapMappingWorkspace {
  organization: Pick<SystemOrganization, 'id' | 'slug' | 'name' | 'themeColor'>;
  mappings: SystemLdapMapping[];
  availableGroups: string[];
}

export interface SystemUserEdit {
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  secondaryEmail: string | null;
  phone: string | null;
  role: string | null;
  expiryDate: string | null;
  disabled: boolean;
  ldapGroups: string[];
  githubUsername: string | null;
  slackUsername: string | null;
  sshPublicKeys: string[];
}

export interface SystemProvisionResult {
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  ldapStatus: string;
  ldapMessage: string;
  tempPassword?: string;
  sshResults: Array<{ preview: string; status: string; message: string }>;
}

export interface SystemGroupProvisioningOptions {
  organizations: Array<{ id: number; name: string }>;
  projects: Array<{ id: number; name: string; orgId: number }>;
  githubTeams: Array<{ slug: string; name: string }>;
  slackChannels: Array<{ id: string; name: string }>;
}

async function integrationChoices<T>(url: string): Promise<T[]> {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 2000);
  try { const response = await fetch(url, { signal: controller.signal }); const body: unknown = await response.json(); return Array.isArray(body) ? body as T[] : []; }
  catch { return []; } finally { clearTimeout(timer); }
}

export async function getSystemGroupProvisioningOptions(): Promise<SystemGroupProvisioningOptions> {
  const [{ rows: organizations }, { rows: projects }, githubTeams, slackChannels] = await Promise.all([
    db.query<{ id: number; name: string }>('SELECT id, name FROM orgs ORDER BY name'),
    db.query<{ id: number; name: string; org_id: number }>('SELECT id, name, org_id FROM projects ORDER BY name'),
    integrationChoices<{ slug: string; name: string }>(`${process.env.GITHUB_APP_URL ?? 'http://github-app:3001'}/teams`),
    integrationChoices<{ id: string; name: string }>(`${process.env.SLACK_BOT_URL ?? 'http://slackbot:3002'}/channels`),
  ]);
  return { organizations, projects: projects.map((project) => ({ id: project.id, name: project.name, orgId: project.org_id })), githubTeams, slackChannels };
}

export async function provisionSystemGroup(actor: string, fields: Record<string, string | string[]>): Promise<{ name: string; status: string; message: string }> {
  const name = String(fields.groupName ?? '').trim(); if (!name) throw data('Group name is required.', { status: 400 });
  const result = await ldap.createGroup(name); if (result.status === 'failed') throw data(result.message, { status: 400 });
  const organizationIds = [...new Set([fields.orgIds ?? []].flat().map(Number).filter(Number.isInteger))];
  const projectId = Number(fields.projectId); const [githubTeamSlug = '', ...githubTeamNameParts] = String(fields.githubTeam ?? '').split('|'); const [slackChannelId = '', ...slackChannelNameParts] = String(fields.slackChannel ?? '').split('|'); const githubTeamName = githubTeamNameParts.join('|'); const slackChannelName = slackChannelNameParts.join('|');
  if (Number.isInteger(projectId)) {
    const { rows } = await db.query<{ org_id: number }>('SELECT org_id FROM projects WHERE id = $1', [projectId]);
    if (!rows[0]) throw data('Project not found.', { status: 404 });
    if (!organizationIds.includes(rows[0].org_id)) organizationIds.push(rows[0].org_id);
  }
  for (const orgId of organizationIds) await db.query('INSERT INTO org_groups (org_id, ldap_group) SELECT id, $2 FROM orgs WHERE id = $1 ON CONFLICT DO NOTHING', [orgId, name]);
  if (Number.isInteger(projectId)) await db.query('INSERT INTO project_ldap_groups (project_id, ldap_group) VALUES ($1, $2) ON CONFLICT DO NOTHING', [projectId, name]);
  if (githubTeamSlug && githubTeamName) await db.query(`INSERT INTO group_mappings (ldap_group, service, target_id, target_name) VALUES ($1, 'github', $2, $3) ON CONFLICT DO NOTHING`, [name, githubTeamSlug, githubTeamName]);
  if (slackChannelId && slackChannelName) await db.query(`INSERT INTO group_mappings (ldap_group, service, target_id, target_name) VALUES ($1, 'slack', $2, $3) ON CONFLICT DO NOTHING`, [name, slackChannelId, slackChannelName]);
  await db.query(`INSERT INTO audit_log (actor, action, details) VALUES ($1, 'create_ldap_group', $2)`, [actor, JSON.stringify({ groupName: name, alreadyExisted: result.status === 'already_exists' })]);
  return { name, status: result.status, message: result.message };
}

export async function listSystemUsers(): Promise<SystemUserSummary[]> {
  const { rows } = await db.query<{
    username: string; first_name: string | null; last_name: string | null; email: string | null;
    role: string | null; disabled: boolean; ldap_groups: string[];
  }>(`SELECT username, first_name, last_name, email, role, disabled, ldap_groups
      FROM users ORDER BY last_name, first_name, username`);
  return rows.map((row) => ({ username: row.username, firstName: row.first_name, lastName: row.last_name, email: row.email, role: row.role, disabled: row.disabled, ldapGroups: row.ldap_groups ?? [] }));
}

export async function syncSystemDirectory(): Promise<{ synced: number; removed: number; errors: number }> {
  return syncUsers();
}

export async function listSystemDirectoryGroups(): Promise<string[]> {
  return ldap.listGroups().catch(() => []);
}

function cleanProvisionFields(fields: Record<string, string | string[]>): { user: NewUser; secondaryEmail: string | null; phone: string | null; githubUsername: string | null; slackUsername: string | null } {
  const firstName = String(fields.firstName ?? '').trim();
  const lastName = String(fields.lastName ?? '').trim();
  const email = String(fields.email ?? '').trim().toLowerCase();
  const role = String(fields.role ?? '').trim();
  const expiryDate = String(fields.expiryDate ?? '').trim();
  if (!firstName || !lastName || !email || !role || !expiryDate) throw data('First name, last name, email, role, and expiry date are required.', { status: 400 });
  const groups = [fields.ldapGroups ?? []].flat().map(String).filter(Boolean);
  const sshPublicKeys = String(fields.sshKeys ?? '').split('\n').map((key) => key.trim()).filter(Boolean);
  return {
    user: { username: ldap.generateUsername(firstName, lastName, email), firstName, lastName, email, role, expiryDate, ldapGroups: [...new Set(groups)], sshPublicKeys, githubTeams: [], serverGroups: [] },
    secondaryEmail: String(fields.secondaryEmail ?? '').trim().toLowerCase() || null,
    phone: String(fields.phone ?? '').trim() || null,
    githubUsername: String(fields.githubUsername ?? '').trim() || null,
    slackUsername: String(fields.slackUsername ?? '').trim() || null,
  };
}

export async function provisionSystemUser(actor: string, fields: Record<string, string | string[]>): Promise<SystemProvisionResult> {
  const { user, secondaryEmail, phone, githubUsername, slackUsername } = cleanProvisionFields(fields);
  const ldapResult = await ldap.createUser(user);
  const sshResults: SystemProvisionResult['sshResults'] = [];
  if (ldapResult.status !== 'failed') for (const key of user.sshPublicKeys) {
    const result = await ldap.addSshKey(user.username, key);
    sshResults.push({ preview: `${key.slice(0, 40)}…`, status: result.status, message: result.message });
  }
  if (ldapResult.status === 'success' || ldapResult.status === 'already_exists') {
    await db.query(`INSERT INTO users (username, first_name, last_name, email, secondary_email, phone, role, expiry_date, ldap_groups, last_synced_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
                    ON CONFLICT (username) DO UPDATE SET role = EXCLUDED.role, updated_at = NOW()`,
      [user.username, user.firstName, user.lastName, user.email, secondaryEmail, phone, user.role, user.expiryDate, user.ldapGroups]);
    await db.query('UPDATE users SET github_username = $1, slack_username = $2, updated_at = NOW() WHERE username = $3', [githubUsername, slackUsername, user.username]);
    if (githubUsername) triggerGithubInvite(githubUsername, undefined);
  }
  await db.query(`INSERT INTO audit_log (actor, action, target_username, details) VALUES ($1, 'create_user', $2, $3)`,
    [actor, user.username, JSON.stringify({ ldapStatus: ldapResult.status, role: user.role, email: user.email })]);
  return { username: user.username, firstName: user.firstName, lastName: user.lastName, email: user.email, ldapStatus: ldapResult.status, ldapMessage: ldapResult.message, tempPassword: ldapResult.tempPassword, sshResults };
}

export async function getSystemUserEdit(username: string): Promise<SystemUserEdit | null> {
  const [{ rows }, ldapUser] = await Promise.all([
    db.query<{ username: string; first_name: string | null; last_name: string | null; email: string | null; secondary_email: string | null; phone: string | null; role: string | null; expiry_date: string | null; disabled: boolean; ldap_groups: string[]; github_username: string | null; slack_username: string | null }>(`SELECT username, first_name, last_name, email, secondary_email, phone, role, TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date, disabled, ldap_groups, github_username, slack_username FROM users WHERE username = $1`, [username]),
    ldap.getUser(username).catch(() => null),
  ]);
  const row = rows[0]; if (!row) return null;
  return { username: row.username, firstName: row.first_name, lastName: row.last_name, email: row.email, secondaryEmail: row.secondary_email, phone: row.phone, role: row.role, expiryDate: row.expiry_date, disabled: row.disabled, ldapGroups: row.ldap_groups ?? [], githubUsername: row.github_username, slackUsername: row.slack_username, sshPublicKeys: ldapUser?.sshPublicKeys ?? [] };
}

export async function updateSystemUser(actor: string, username: string, fields: Record<string, string | string[]>): Promise<void> {
  const current = await getSystemUserEdit(username); if (!current) throw data('Directory user not found.', { status: 404 });
  const firstName = String(fields.firstName ?? '').trim(); const lastName = String(fields.lastName ?? '').trim(); const email = String(fields.email ?? '').trim().toLowerCase();
  if (!firstName || !lastName || !email) throw data('First name, last name, and email are required.', { status: 400 });
  const groups = [...new Set([fields.groups ?? []].flat().map(String).filter(Boolean))]; const sshKeys = String(fields.sshKeys ?? '').split('\n').map((key) => key.trim()).filter(Boolean);
  const [profile, groupResult, expiry, ssh] = await Promise.all([ldap.updateUserProfile(username, { firstName, lastName, email }), ldap.updateUserGroups(username, groups), ldap.updateUserExpiry(username, String(fields.expiryDate ?? '') || null), ldap.setSshKeys(username, sshKeys)]);
  const ldapError = [profile, groupResult, expiry, ssh].find((result) => result.status === 'failed')?.message;
  if (ldapError) throw data(ldapError, { status: 400 });
  const githubUsername = String(fields.githubUsername ?? '').trim() || null; const slackUsername = String(fields.slackUsername ?? '').trim() || null;
  await db.query(`UPDATE users SET first_name=$1, last_name=$2, email=$3, role=$4, expiry_date=$5, ldap_groups=$6, github_username=$7, slack_username=$8, secondary_email=$9, phone=$10, updated_at=NOW() WHERE username=$11`, [firstName, lastName, email, String(fields.role ?? '').trim() || null, String(fields.expiryDate ?? '') || null, groups, githubUsername, slackUsername, String(fields.secondaryEmail ?? '').trim().toLowerCase() || null, String(fields.phone ?? '').trim() || null, username]);
  if (githubUsername) triggerGithubInvite(githubUsername, undefined);
  await db.query(`INSERT INTO audit_log (actor, action, target_username, details) VALUES ($1, 'edit_user', $2, $3)`, [actor, username, JSON.stringify({ firstName, lastName, email, groups })]);
}

export async function listSystemAudit(days: number): Promise<{ days: number; entries: SystemAuditEntry[] }> {
  const safeDays = [1, 7, 14, 30, 90].includes(days) ? days : 7;
  const { rows } = await db.query<{
    id: number; actor: string; action: string; target_username: string | null; details: unknown | null;
    created_at: string; org_name: string | null; org_slug: string | null;
  }>(`SELECT al.id, al.actor, al.action, al.target_username, al.details,
              TO_CHAR(al.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS created_at,
              o.name AS org_name, o.slug AS org_slug
       FROM audit_log al LEFT JOIN orgs o ON o.id = al.org_id
       WHERE al.created_at >= NOW() - ($1 || ' days')::INTERVAL
       ORDER BY al.created_at DESC LIMIT 1000`, [safeDays]);
  return { days: safeDays, entries: rows.map((row) => ({ id: row.id, actor: row.actor, action: row.action, targetUsername: row.target_username, details: row.details, createdAt: row.created_at, orgName: row.org_name, orgSlug: row.org_slug })) };
}

export async function listSystemOrganizations(): Promise<SystemOrganization[]> {
  const { rows } = await db.query<{
    id: number; slug: string; name: string; description: string | null; theme_color: string | null; member_count: string;
  }>(`SELECT o.id, o.slug, o.name, o.description, o.theme_color, COUNT(uo.username)::text AS member_count
      FROM orgs o LEFT JOIN user_orgs uo ON uo.org_id = o.id GROUP BY o.id ORDER BY o.name`);
  return rows.map((row) => ({ id: row.id, slug: row.slug, name: row.name, description: row.description, themeColor: row.theme_color, memberCount: Number(row.member_count) }));
}

function validThemeColor(value: string): boolean { return /^#[0-9A-Fa-f]{6}$/.test(value); }

export async function createSystemOrganization(fields: { slug: string; name: string; description: string; themeColor: string }): Promise<void> {
  const slug = fields.slug.trim().toLowerCase(); const name = fields.name.trim();
  if (!slug || !name) throw data('Slug and name are required.', { status: 400 });
  const color = validThemeColor(fields.themeColor) ? fields.themeColor : null;
  await db.query('INSERT INTO orgs (slug, name, description, theme_color) VALUES ($1, $2, $3, $4)', [slug, name, fields.description.trim() || null, color]);
}

export async function updateSystemOrganizationTheme(id: number, themeColor: string): Promise<void> {
  if (!Number.isInteger(id) || !validThemeColor(themeColor)) throw data('A valid organization and hex color are required.', { status: 400 });
  await db.query('UPDATE orgs SET theme_color = $1 WHERE id = $2', [themeColor, id]);
}

export async function deleteSystemOrganization(id: number, confirmed: boolean): Promise<void> {
  if (!Number.isInteger(id)) throw data('Invalid organization.', { status: 400 });
  if (!confirmed) throw data('Confirm removal before deleting an organization and its related data.', { status: 400 });
  // Audit history is retained when a workspace is removed; its organization
  // reference becomes historical rather than blocking a confirmed deletion.
  await db.query('UPDATE audit_log SET org_id = NULL WHERE org_id = $1', [id]);
  await db.query('DELETE FROM orgs WHERE id = $1', [id]);
}

const mappingRoles = new Set<SystemLdapMapping['role']>(['member', 'project_lead', 'org_admin', 'utility']);

export async function getSystemLdapMappings(orgId: number): Promise<SystemLdapMappingWorkspace | null> {
  if (!Number.isInteger(orgId)) throw data('Invalid organization.', { status: 400 });
  const [{ rows: organizations }, { rows: mappings }, ldapGroups] = await Promise.all([
    db.query<{ id: number; slug: string; name: string; theme_color: string | null }>('SELECT id, slug, name, theme_color FROM orgs WHERE id = $1', [orgId]),
    db.query<{ id: number; ldap_group: string; role: SystemLdapMapping['role'] }>('SELECT id, ldap_group, role FROM org_ldap_group_mappings WHERE org_id = $1 ORDER BY role, ldap_group', [orgId]),
    ldap.listGroups().catch(() => []),
  ]);
  const organization = organizations[0];
  if (!organization) return null;
  const mapped = new Set(mappings.map((mapping) => mapping.ldap_group));
  return {
    organization: { id: organization.id, slug: organization.slug, name: organization.name, themeColor: organization.theme_color },
    mappings: mappings.map((mapping) => ({ id: mapping.id, ldapGroup: mapping.ldap_group, role: mapping.role })),
    availableGroups: ldapGroups.filter((group) => !mapped.has(group)),
  };
}

function requireMappingRole(role: string): asserts role is SystemLdapMapping['role'] {
  if (!mappingRoles.has(role as SystemLdapMapping['role'])) throw data('Invalid LDAP mapping role.', { status: 400 });
}

export async function addSystemLdapMapping(orgId: number, ldapGroup: string, role: string): Promise<void> {
  if (!Number.isInteger(orgId) || !ldapGroup.trim()) throw data('LDAP group and role are required.', { status: 400 });
  requireMappingRole(role);
  const { rowCount } = await db.query('SELECT 1 FROM orgs WHERE id = $1', [orgId]);
  if ((rowCount ?? 0) === 0) throw data('Organization not found.', { status: 404 });
  const group = ldapGroup.trim();
  await db.query(`INSERT INTO org_ldap_group_mappings (org_id, ldap_group, role)
                  VALUES ($1, $2, $3) ON CONFLICT (org_id, ldap_group) DO UPDATE SET role = EXCLUDED.role`, [orgId, group, role]);
  await db.query('INSERT INTO org_groups (org_id, ldap_group) VALUES ($1, $2) ON CONFLICT DO NOTHING', [orgId, group]);
}

export async function updateSystemLdapMappingRole(orgId: number, mappingId: number, role: string): Promise<void> {
  if (!Number.isInteger(orgId) || !Number.isInteger(mappingId)) throw data('Invalid LDAP mapping.', { status: 400 });
  requireMappingRole(role);
  const { rowCount } = await db.query('UPDATE org_ldap_group_mappings SET role = $1 WHERE id = $2 AND org_id = $3', [role, mappingId, orgId]);
  if ((rowCount ?? 0) === 0) throw data('LDAP mapping not found.', { status: 404 });
}

export async function deleteSystemLdapMapping(orgId: number, mappingId: number): Promise<void> {
  if (!Number.isInteger(orgId) || !Number.isInteger(mappingId)) throw data('Invalid LDAP mapping.', { status: 400 });
  await db.query('DELETE FROM org_ldap_group_mappings WHERE id = $1 AND org_id = $2', [mappingId, orgId]);
}

export async function syncSystemLdapMappings(orgId: number, actor: string): Promise<number> {
  if (!Number.isInteger(orgId)) throw data('Invalid organization.', { status: 400 });
  const { rows: mappings } = await db.query<{ ldap_group: string; role: SystemLdapMapping['role'] }>('SELECT ldap_group, role FROM org_ldap_group_mappings WHERE org_id = $1', [orgId]);
  const priorities: Record<SystemLdapMapping['role'], number> = { org_admin: 3, project_lead: 2, member: 1, utility: 0 };
  const userRoles = new Map<string, SystemLdapMapping['role']>();
  for (const mapping of mappings) {
    if (mapping.role === 'utility') continue;
    const { rows: users } = await db.query<{ username: string }>('SELECT username FROM users WHERE $1 = ANY(ldap_groups)', [mapping.ldap_group]);
    for (const user of users) {
      const current = userRoles.get(user.username);
      if (!current || priorities[mapping.role] > priorities[current]) userRoles.set(user.username, mapping.role);
    }
  }
  for (const [username, role] of userRoles) {
    await db.query(`INSERT INTO user_orgs (username, org_id, role) VALUES ($1, $2, $3)
                    ON CONFLICT (username, org_id) DO UPDATE SET role = EXCLUDED.role`, [username, orgId, role]);
  }
  await db.query(`INSERT INTO audit_log (actor, action, details, org_id) VALUES ($1, 'sync_org_membership', $2, $3)`, [actor, JSON.stringify({ usersAdded: userRoles.size }), orgId]);
  return userRoles.size;
}

export async function listLocalAdmins(): Promise<LocalAdminSummary[]> {
  const { rows } = await db.query<{
    id: number; username: string; enabled: boolean; last_used_at: Date | null; created_at: Date;
  }>('SELECT id, username, enabled, last_used_at, created_at FROM local_admins ORDER BY created_at');
  return rows.map((row) => ({
    id: row.id, username: row.username, enabled: row.enabled,
    lastUsedAt: row.last_used_at?.toISOString() ?? null, createdAt: row.created_at.toISOString(),
  }));
}

export async function createLocalAdmin(username: string, password: string): Promise<void> {
  const cleanUsername = username.trim();
  if (!cleanUsername || !password) throw data('Username and password are required.', { status: 400 });
  const hash = await bcrypt.hash(password, 12);
  await db.query(
    `INSERT INTO local_admins (username, password_hash) VALUES ($1, $2)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, enabled = TRUE, updated_at = NOW()`,
    [cleanUsername, hash],
  );
}

export async function toggleLocalAdmin(id: number): Promise<void> {
  if (!Number.isInteger(id)) throw data('Invalid local administrator.', { status: 400 });
  await db.query('UPDATE local_admins SET enabled = NOT enabled, updated_at = NOW() WHERE id = $1', [id]);
}

export async function deleteLocalAdmin(id: number, confirmed: boolean): Promise<void> {
  if (!Number.isInteger(id)) throw data('Invalid local administrator.', { status: 400 });
  if (!confirmed) throw data('Confirm removal before deleting a break-glass administrator.', { status: 400 });
  await db.query('DELETE FROM local_admins WHERE id = $1', [id]);
}
