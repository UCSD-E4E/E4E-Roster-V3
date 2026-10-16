import { data } from 'react-router';
import { db } from '../services/db';
import { upsertUserOrgMembership } from '../services/db';
import * as ldap from '../services/ldap';
import { triggerGithubInvite } from '../services/integrations';
import { requireOrgAdmin } from './access';
import type { RosterUiContext } from './projects.server';

export interface OrganizationPersonUpdate {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  expiryDate: string;
  groups: string[];
  githubUsername: string;
  slackUsername: string;
  secondaryEmail: string;
  phone: string;
  sshKeys: string;
}

/** Add an existing directory account to this organisation, or change its role. */
export async function addOrganizationPerson(
  context: RosterUiContext,
  username: string,
  role: string,
): Promise<void> {
  requireOrgAdmin(context);
  if (!['org_admin', 'project_lead', 'member'].includes(role)) {
    throw data('Invalid organization role.', { status: 400 });
  }
  const { rowCount } = await db.query('SELECT 1 FROM users WHERE username = $1', [username]);
  if ((rowCount ?? 0) === 0) throw data('Person not found.', { status: 404 });

  await upsertUserOrgMembership(username, context.org.id, role);
  await db.query(
    `INSERT INTO audit_log (actor, action, target_username, details, org_id)
     VALUES ($1, 'add_user_to_org', $2, $3, $4)`,
    [context.user.username, username, JSON.stringify({ role }), context.org.id],
  );
}

/** Update the directory and roster fields that an organization admin owns. */
export async function updateOrganizationPerson(
  context: RosterUiContext,
  username: string,
  fields: OrganizationPersonUpdate,
): Promise<void> {
  requireOrgAdmin(context);
  const firstName = fields.firstName.trim();
  const lastName = fields.lastName.trim();
  const email = fields.email.trim().toLowerCase();
  if (!firstName || !lastName || !email) throw data('First name, last name, and institutional email are required.', { status: 400 });

  const selectedGroups = [...new Set(fields.groups)];
  const sshPublicKeys = fields.sshKeys.split('\n').map((key) => key.trim()).filter(Boolean);
  const [{ rows: currentRows }, { rows: orgGroupRows }] = await Promise.all([
    db.query<{ ldap_groups: string[] }>(
      `SELECT u.ldap_groups FROM users u JOIN user_orgs uo ON uo.username = u.username AND uo.org_id = $2
       WHERE u.username = $1`, [username, context.org.id],
    ),
    db.query<{ ldap_group: string }>('SELECT ldap_group FROM org_groups WHERE org_id = $1', [context.org.id]),
  ]);
  if (!currentRows.length) throw data('Person not found in this organization.', { status: 404 });
  const orgGroups = new Set(orgGroupRows.map((row) => row.ldap_group));
  if (!selectedGroups.every((group) => orgGroups.has(group))) throw data('Submitted groups do not belong to this organization.', { status: 400 });
  const nonOrgGroups = (currentRows[0].ldap_groups ?? []).filter((group) => !orgGroups.has(group));
  const mergedGroups = [...new Set([...nonOrgGroups, ...selectedGroups])];
  const [profile, groups, expiry, ssh] = await Promise.all([
    ldap.updateUserProfile(username, { firstName, lastName, email }),
    ldap.updateUserGroups(username, mergedGroups),
    ldap.updateUserExpiry(username, fields.expiryDate || null),
    ldap.setSshKeys(username, sshPublicKeys),
  ]);
  const ldapError = [profile, groups, expiry, ssh].find((result) => result.status === 'failed')?.message;
  if (ldapError) throw data(ldapError, { status: 400 });

  const githubUsername = fields.githubUsername.trim() || null;
  const slackUsername = fields.slackUsername.trim() || null;
  const secondaryEmail = fields.secondaryEmail.trim().toLowerCase() || null;
  const phone = fields.phone.trim() || null;
  await db.query(
    `UPDATE users SET first_name=$1, last_name=$2, email=$3, role=$4, expiry_date=$5, ldap_groups=$6,
      github_username=$7, slack_username=$8, secondary_email=$9, phone=$10, updated_at=NOW() WHERE username=$11`,
    [firstName, lastName, email, fields.role || null, fields.expiryDate || null, mergedGroups,
      githubUsername, slackUsername, secondaryEmail, phone, username],
  );
  if (githubUsername) triggerGithubInvite(githubUsername, context.org.id);
  await db.query(
    `INSERT INTO audit_log (actor, action, target_username, details, org_id) VALUES ($1, 'edit_user', $2, $3, $4)`,
    [context.user.username, username, JSON.stringify({ firstName, lastName, email, role: fields.role, expiryDate: fields.expiryDate || null, groups: mergedGroups, githubUsername, slackUsername }), context.org.id],
  );
}
