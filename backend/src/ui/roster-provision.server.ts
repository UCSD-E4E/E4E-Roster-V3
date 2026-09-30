import { data } from 'react-router';
import { db, ensureUserOrgMembership } from '../services/db';
import * as ldap from '../services/ldap';
import { triggerGithubInvite } from '../services/integrations';
import type { NewUser } from '../services/types';
import { requireOrgAdmin } from './access';
import { getProject, type RosterUiContext } from './projects.server';

export interface RosterProvisionResult {
  username: string;
  email: string;
  ldapStatus: string;
  ldapMessage: string;
  tempPassword?: string;
  sshResults: Array<{ preview: string; status: string; message: string }>;
}

function fieldsFromForm(fields: Record<string, string | string[]>, projectMode: boolean): { user: NewUser; secondaryEmail: string | null; phone: string | null; githubUsername: string | null; slackUsername: string | null } {
  const firstName = String(fields.firstName ?? '').trim(); const lastName = String(fields.lastName ?? '').trim(); const email = String(fields.email ?? '').trim().toLowerCase();
  if (!firstName || !lastName || !email) throw data('First name, last name, and institutional email are required.', { status: 400 });
  const ldapGroups = [...new Set([fields.ldapGroups ?? []].flat().map(String).filter(Boolean))];
  const role = projectMode ? 'student' : String(fields.role ?? '').trim();
  const expiryDate = projectMode ? ninetyDaysFromNow() : String(fields.expiryDate ?? '').trim();
  if (!role || !expiryDate) throw data('Role and expiry date are required.', { status: 400 });
  return { user: { username: ldap.generateUsername(firstName, lastName, email), firstName, lastName, email, role, expiryDate, ldapGroups, sshPublicKeys: String(fields.sshKeys ?? '').split('\n').map((key) => key.trim()).filter(Boolean), githubTeams: [], serverGroups: [] }, secondaryEmail: String(fields.secondaryEmail ?? '').trim().toLowerCase() || null, phone: String(fields.phone ?? '').trim() || null, githubUsername: String(fields.githubUsername ?? '').trim() || null, slackUsername: String(fields.slackUsername ?? '').trim() || null };
}

function ninetyDaysFromNow(): string { const date = new Date(); date.setDate(date.getDate() + 90); return date.toISOString().slice(0, 10); }

async function persistProvision(context: RosterUiContext, user: NewUser, secondaryEmail: string | null, phone: string | null, githubUsername: string | null, slackUsername: string | null, action: string, projectId?: number): Promise<RosterProvisionResult> {
  const ldapResult = await ldap.createUser(user); const sshResults: RosterProvisionResult['sshResults'] = [];
  if (ldapResult.status !== 'failed') for (const key of user.sshPublicKeys) { const result = await ldap.addSshKey(user.username, key); sshResults.push({ preview: `${key.slice(0, 40)}…`, status: result.status, message: result.message }); }
  if (ldapResult.status === 'success' || ldapResult.status === 'already_exists') {
    await db.query(`INSERT INTO users (username, first_name, last_name, email, secondary_email, phone, role, expiry_date, ldap_groups, github_username, slack_username, last_synced_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
                    ON CONFLICT (username) DO UPDATE SET role=EXCLUDED.role, updated_at=NOW()`, [user.username, user.firstName, user.lastName, user.email, secondaryEmail, phone, user.role, user.expiryDate, user.ldapGroups, githubUsername, slackUsername]);
    await ensureUserOrgMembership(user.username, context.org.id);
    if (githubUsername) triggerGithubInvite(githubUsername, context.org.id);
  }
  await db.query(`INSERT INTO audit_log (actor, action, target_username, details, org_id) VALUES ($1, $2, $3, $4, $5)`, [context.user.username, action, user.username, JSON.stringify({ ldapStatus: ldapResult.status, role: user.role, groups: user.ldapGroups, projectId }), context.org.id]);
  return { username: user.username, email: user.email, ldapStatus: ldapResult.status, ldapMessage: ldapResult.message, tempPassword: ldapResult.tempPassword, sshResults };
}

export async function provisionOrganizationPerson(context: RosterUiContext, fields: Record<string, string | string[]>): Promise<RosterProvisionResult> {
  requireOrgAdmin(context); const { user, secondaryEmail, phone, githubUsername, slackUsername } = fieldsFromForm(fields, false);
  const { rows } = await db.query<{ ldap_group: string }>('SELECT ldap_group FROM org_groups WHERE org_id = $1', [context.org.id]); const allowed = new Set(rows.map((row) => row.ldap_group));
  if (!user.ldapGroups.every((group) => allowed.has(group))) throw data('Submitted groups do not belong to this organization.', { status: 400 });
  return persistProvision(context, user, secondaryEmail, phone, githubUsername, slackUsername, 'create_user');
}

export async function provisionProjectPerson(context: RosterUiContext, projectId: number, fields: Record<string, string | string[]>): Promise<RosterProvisionResult> {
  const project = await getProject(context, projectId); if (!project) throw data('Project not found.', { status: 404 }); const { user, secondaryEmail, phone, githubUsername, slackUsername } = fieldsFromForm(fields, true);
  if (user.ldapGroups.length === 0 || !user.ldapGroups.every((group) => project.groups.includes(group))) throw data('Choose one or more groups belonging to this project.', { status: 400 });
  return persistProvision(context, user, secondaryEmail, phone, githubUsername, slackUsername, 'pl_create_user', projectId);
}
