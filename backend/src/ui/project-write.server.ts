import { data } from 'react-router';
import { db } from '../services/db';
import { ensureUserOrgMembership } from '../services/db';
import * as ldap from '../services/ldap';
import { triggerGithubInvite } from '../services/integrations';
import { getProject, getProjectMemberEdit, type RosterUiContext } from './projects.server';

export interface ProjectMemberUpdate {
  groups: string[];
  githubUsername: string;
  slackUsername: string;
  secondaryEmail: string;
  phone: string;
  disabled: string;
  sshKeys: string;
}

/** Add an existing directory account to an accessible project's LDAP groups. */
export async function addProjectMember(
  context: RosterUiContext,
  projectId: number,
  username: string,
  groups: string[],
): Promise<void> {
  const project = await getProject(context, projectId);
  if (!project) throw data('Project not found.', { status: 404 });
  const selectedGroups = [...new Set(groups)];
  if (selectedGroups.length === 0) throw data('Choose at least one project group.', { status: 400 });
  if (!selectedGroups.every((group) => project.groups.includes(group))) {
    throw data('Submitted groups do not belong to this project.', { status: 400 });
  }

  const { rows } = await db.query<{ ldap_groups: string[] }>(
    'SELECT ldap_groups FROM users WHERE username = $1', [username],
  );
  const member = rows[0];
  if (!member) throw data('Person not found.', { status: 404 });
  if ((member.ldap_groups ?? []).includes(process.env.ADMIN_GROUP ?? 'e4e-admin')) {
    throw data('Administrator accounts cannot be managed from a project.', { status: 403 });
  }
  const nonProjectGroups = (member.ldap_groups ?? []).filter((group) => !project.groups.includes(group));
  const mergedGroups = [...new Set([...nonProjectGroups, ...selectedGroups])];
  const result = await ldap.updateUserGroups(username, mergedGroups);
  if (result.status === 'failed') throw data(result.message, { status: 400 });

  await db.query('UPDATE users SET ldap_groups = $1, updated_at = NOW() WHERE username = $2', [mergedGroups, username]);
  await ensureUserOrgMembership(username, context.org.id);
  await db.query(
    `INSERT INTO audit_log (actor, action, target_username, details, org_id)
     VALUES ($1, 'pl_add_to_project', $2, $3, $4)`,
    [context.user.username, username, JSON.stringify({ projectId, groups: mergedGroups }), context.org.id],
  );
}

/** Update only the fields a project workspace may manage for an eligible member. */
export async function updateProjectMember(
  context: RosterUiContext,
  projectId: number,
  username: string,
  fields: ProjectMemberUpdate,
): Promise<void> {
  const edit = await getProjectMemberEdit(context, projectId, username);
  if (!edit) throw data('Project member not found.', { status: 404 });
  const selectedGroups = [...new Set(fields.groups)];
  if (!selectedGroups.every((group) => edit.project.groups.includes(group))) {
    throw data('Submitted groups do not belong to this project.', { status: 400 });
  }
  const nonProjectGroups = edit.member.ldapGroups.filter((group) => !edit.project.groups.includes(group));
  const mergedGroups = [...new Set([...nonProjectGroups, ...selectedGroups])];
  const sshPublicKeys = fields.sshKeys.split('\n').map((key) => key.trim()).filter(Boolean);
  const [groupResult, sshResult] = await Promise.all([
    ldap.updateUserGroups(username, mergedGroups),
    ldap.setSshKeys(username, sshPublicKeys),
  ]);
  const ldapError = [groupResult, sshResult].find((result) => result.status === 'failed')?.message;
  if (ldapError) throw data(ldapError, { status: 400 });
  const githubUsername = fields.githubUsername.trim() || null;
  const slackUsername = fields.slackUsername.trim() || null;
  const secondaryEmail = fields.secondaryEmail.trim().toLowerCase() || null;
  const phone = fields.phone.trim() || null;
  await db.query(
    `UPDATE users SET ldap_groups=$1, github_username=$2, slack_username=$3,
       secondary_email=$4, phone=$5, disabled=$6, updated_at=NOW() WHERE username=$7`,
    [mergedGroups, githubUsername, slackUsername, secondaryEmail, phone, fields.disabled === 'true', username],
  );
  if (githubUsername) triggerGithubInvite(githubUsername, context.org.id);
  await db.query(
    `INSERT INTO audit_log (actor, action, target_username, details, org_id)
     VALUES ($1, 'pl_edit_user', $2, $3, $4)`,
    [context.user.username, username, JSON.stringify({ projectId, groups: mergedGroups, sshKeyCount: sshPublicKeys.length }), context.org.id],
  );
}
