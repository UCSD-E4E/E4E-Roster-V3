import { db } from '../services/db';
import * as ldap from '../services/ldap';
import { AuthUser, OrgMembership } from '../types/user';
import { data } from 'react-router';
import { canAdminOrg, requireOrgAdmin } from './access';

export interface RosterUiContext {
  user: AuthUser;
  org: { id: number; slug: string; name: string; themeColor: string | null };
  membership: OrgMembership;
  basePath: string;
}

export interface ProjectSummary {
  id: number;
  name: string;
  description: string | null;
  memberCount: number;
  groups: string[];
}

export interface ProjectMember {
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
  disabled: boolean;
  groups: string[];
}

export interface ProjectDetail extends ProjectSummary {
  members: ProjectMember[];
}

export interface ProjectAuditEntry {
  actor: string;
  action: string;
  details: string | null;
  createdAt: string;
}

export interface ProjectMemberAudit {
  project: ProjectDetail;
  member: ProjectMember;
  entries: ProjectAuditEntry[];
}

export interface ProjectSettings {
  project: ProjectDetail;
  orgGroups: string[];
}

export interface ProjectMemberEdit {
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  secondaryEmail: string | null;
  phone: string | null;
  disabled: boolean;
  ldapGroups: string[];
  githubUsername: string | null;
  slackUsername: string | null;
  sshPublicKeys: string[];
}

function requireProjectWorkspaceRole(context: RosterUiContext): void {
  if (canAdminOrg(context) || context.membership.role === 'project_lead') return;
  throw data('Project workspace access required.', { status: 403 });
}

export async function listProjects(context: RosterUiContext): Promise<ProjectSummary[]> {
  requireProjectWorkspaceRole(context);
  const admin = canAdminOrg(context);
  const groups = context.user.groups ?? [];

  if (!admin && groups.length === 0) return [];

  const { rows } = await db.query<{
    id: number;
    name: string;
    description: string | null;
    member_count: number;
    groups: string[];
  }>(`
    SELECT p.id, p.name, p.description,
           COUNT(DISTINCT uo.username)::int AS member_count,
           COALESCE(ARRAY_AGG(DISTINCT plg.ldap_group)
             FILTER (WHERE plg.ldap_group IS NOT NULL), '{}') AS groups
    FROM projects p
    LEFT JOIN project_ldap_groups plg ON plg.project_id = p.id
    LEFT JOIN users u ON plg.ldap_group = ANY(u.ldap_groups)
    LEFT JOIN user_orgs uo ON uo.username = u.username AND uo.org_id = p.org_id
    WHERE p.org_id = $1
      AND ($2::boolean OR plg.ldap_group = ANY($3::text[]))
    GROUP BY p.id
    ORDER BY p.name
  `, [context.org.id, admin, groups]);

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    memberCount: row.member_count,
    groups: row.groups,
  }));
}

export async function getProject(
  context: RosterUiContext,
  projectId: number,
): Promise<ProjectDetail | null> {
  requireProjectWorkspaceRole(context);
  const admin = canAdminOrg(context);
  const groups = context.user.groups ?? [];

  const { rows: projects } = await db.query<{
    id: number;
    name: string;
    description: string | null;
  }>(`
    SELECT DISTINCT p.id, p.name, p.description
    FROM projects p
    LEFT JOIN project_ldap_groups plg ON plg.project_id = p.id
    WHERE p.id = $1 AND p.org_id = $2
      AND ($3::boolean OR plg.ldap_group = ANY($4::text[]))
  `, [projectId, context.org.id, admin, groups]);

  const project = projects[0];
  if (!project) return null;

  const [{ rows: groupRows }, { rows: memberRows }] = await Promise.all([
    db.query<{ ldap_group: string }>(
      'SELECT ldap_group FROM project_ldap_groups WHERE project_id = $1 ORDER BY ldap_group',
      [projectId],
    ),
    db.query<{
      username: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      role: string | null;
      disabled: boolean;
      ldap_groups: string[];
    }>(`
      SELECT DISTINCT u.username, u.first_name, u.last_name, u.email, u.role,
             u.disabled, u.ldap_groups
      FROM users u
      JOIN user_orgs uo ON uo.username = u.username AND uo.org_id = $2
      WHERE EXISTS (
        SELECT 1 FROM project_ldap_groups plg
        WHERE plg.project_id = $1 AND plg.ldap_group = ANY(u.ldap_groups)
      )
      ORDER BY u.last_name, u.first_name, u.username
    `, [projectId, context.org.id]),
  ]);

  return {
    id: project.id,
    name: project.name,
    description: project.description,
    memberCount: memberRows.length,
    groups: groupRows.map((row) => row.ldap_group),
    members: memberRows.map((row) => ({
      username: row.username,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      role: row.role,
      disabled: row.disabled,
      groups: row.ldap_groups.filter((group) => groupRows.some((mapped) => mapped.ldap_group === group)),
    })),
  };
}

export async function updateProject(
  context: RosterUiContext,
  projectId: number,
  fields: { name: string; description: string | null },
): Promise<boolean> {
  requireOrgAdmin(context);

  const { rowCount } = await db.query(
    `UPDATE projects SET name = $1, description = $2
     WHERE id = $3 AND org_id = $4`,
    [fields.name, fields.description, projectId, context.org.id],
  );
  return (rowCount ?? 0) > 0;
}

export async function getProjectMemberAudit(
  context: RosterUiContext,
  projectId: number,
  username: string,
): Promise<ProjectMemberAudit | null> {
  const project = await getProject(context, projectId);
  const member = project?.members.find((candidate) => candidate.username === username);
  if (!project || !member) return null;

  const { rows } = await db.query<{
    actor: string;
    action: string;
    details: unknown;
    created_at: Date;
  }>(`
    SELECT actor, action, details, created_at
    FROM audit_log
    WHERE target_username = $1 AND (org_id = $2 OR org_id IS NULL)
    ORDER BY created_at DESC
    LIMIT 100
  `, [username, context.org.id]);

  return {
    project,
    member,
    entries: rows.map((row) => ({
      actor: row.actor,
      action: row.action,
      details: row.details === null ? null : typeof row.details === 'string' ? row.details : JSON.stringify(row.details),
      createdAt: row.created_at.toISOString(),
    })),
  };
}

export async function getProjectSettings(
  context: RosterUiContext,
  projectId: number,
): Promise<ProjectSettings | null> {
  requireOrgAdmin(context);
  const project = await getProject(context, projectId);
  if (!project) return null;
  const { rows } = await db.query<{ ldap_group: string }>(
    'SELECT ldap_group FROM org_groups WHERE org_id = $1 ORDER BY ldap_group',
    [context.org.id],
  );
  return { project, orgGroups: rows.map((row) => row.ldap_group) };
}

export async function getProjectMemberEdit(
  context: RosterUiContext,
  projectId: number,
  username: string,
): Promise<{ project: ProjectDetail; member: ProjectMemberEdit } | null> {
  const project = await getProject(context, projectId);
  if (!project || !project.members.some((member) => member.username === username)) return null;
  const { rows } = await db.query<{
    username: string; first_name: string | null; last_name: string | null; email: string | null;
    secondary_email: string | null; phone: string | null; disabled: boolean; ldap_groups: string[];
    github_username: string | null; slack_username: string | null;
  }>(`
    SELECT u.username, u.first_name, u.last_name, u.email, u.secondary_email, u.phone,
           u.disabled, u.ldap_groups, u.github_username, u.slack_username
    FROM users u JOIN user_orgs uo ON uo.username = u.username AND uo.org_id = $3
    WHERE u.username = $1 AND EXISTS (
      SELECT 1 FROM project_ldap_groups plg
      WHERE plg.project_id = $2 AND plg.ldap_group = ANY(u.ldap_groups)
    )
  `, [username, projectId, context.org.id]);
  const row = rows[0];
  if (!row) return null;
  if ((row.ldap_groups ?? []).includes(process.env.ADMIN_GROUP ?? 'e4e-admin')) {
    throw data('Project leads cannot edit administrator accounts.', { status: 403 });
  }
  const ldapUser = await ldap.getUser(username).catch(() => null);
  return { project, member: {
    username: row.username, firstName: row.first_name, lastName: row.last_name, email: row.email,
    secondaryEmail: row.secondary_email, phone: row.phone, disabled: row.disabled,
    ldapGroups: row.ldap_groups ?? [], githubUsername: row.github_username,
    slackUsername: row.slack_username, sshPublicKeys: ldapUser?.sshPublicKeys ?? [],
  } };
}

export async function createProject(
  context: RosterUiContext,
  fields: { name: string; description: string | null },
): Promise<number> {
  requireOrgAdmin(context);
  const { rows } = await db.query<{ id: number }>(
    'INSERT INTO projects (name, description, org_id) VALUES ($1, $2, $3) RETURNING id',
    [fields.name, fields.description, context.org.id],
  );
  return rows[0].id;
}

export async function addProjectGroup(
  context: RosterUiContext,
  projectId: number,
  ldapGroup: string,
): Promise<boolean> {
  requireOrgAdmin(context);
  const { rowCount } = await db.query(
    `INSERT INTO project_ldap_groups (project_id, ldap_group)
     SELECT $1, $2 FROM org_groups WHERE org_id = $3 AND ldap_group = $2
     ON CONFLICT DO NOTHING`,
    [projectId, ldapGroup, context.org.id],
  );
  return (rowCount ?? 0) > 0;
}

export async function removeProjectGroup(
  context: RosterUiContext,
  projectId: number,
  ldapGroup: string,
): Promise<void> {
  requireOrgAdmin(context);
  await db.query(
    `DELETE FROM project_ldap_groups plg
     USING projects p
     WHERE plg.project_id = p.id AND p.id = $1 AND p.org_id = $2 AND plg.ldap_group = $3`,
    [projectId, context.org.id, ldapGroup],
  );
}
