import { data } from 'react-router';
import { db } from '../services/db';
import * as ldap from '../services/ldap';
import { syncUsers } from '../services/sync';
import { canViewPeople, requireOrgAdmin } from './access';
import type { RosterUiContext } from './projects.server';

export interface OrgPerson {
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  role: string | null;
  orgRole: string;
  disabled: boolean;
  groups: string[];
}

export interface PersonSearchResult {
  username: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  orgRole: string | null;
  isDirectoryAdmin: boolean;
  ldapGroups: string[];
}

export interface OrgPersonEdit {
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

export async function listPeople(context: RosterUiContext): Promise<OrgPerson[]> {
  if (!canViewPeople(context)) throw data('People workspace access required.', { status: 403 });

  const { rows } = await db.query<{
    username: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    role: string | null;
    org_role: string;
    disabled: boolean;
    ldap_groups: string[];
    org_groups: string[];
  }>(`
    SELECT u.username, u.first_name, u.last_name, u.email, u.role,
           uo.role AS org_role, u.disabled, u.ldap_groups,
           COALESCE(ARRAY_AGG(og.ldap_group) FILTER (WHERE og.ldap_group IS NOT NULL), '{}') AS org_groups
    FROM users u
    JOIN user_orgs uo ON uo.username = u.username AND uo.org_id = $1
    LEFT JOIN org_groups og ON og.org_id = uo.org_id AND og.ldap_group = ANY(u.ldap_groups)
    GROUP BY u.username, u.first_name, u.last_name, u.email, u.role, uo.role, u.disabled, u.ldap_groups
    ORDER BY u.last_name, u.first_name, u.username
  `, [context.org.id]);

  return rows.map((row) => ({
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    role: row.role,
    orgRole: row.org_role,
    disabled: row.disabled,
    groups: row.org_groups,
  }));
}

export async function listOrgGroups(context: RosterUiContext): Promise<string[]> {
  requireOrgAdmin(context);
  const { rows } = await db.query<{ ldap_group: string }>(
    'SELECT ldap_group FROM org_groups WHERE org_id = $1 ORDER BY ldap_group',
    [context.org.id],
  );
  return rows.map((row) => row.ldap_group);
}

export async function syncOrganizationDirectory(context: RosterUiContext): Promise<{ synced: number; removed: number; errors: number }> {
  requireOrgAdmin(context);
  return syncUsers();
}

export async function getOrgPersonEdit(
  context: RosterUiContext,
  username: string,
): Promise<{ person: OrgPersonEdit; groups: string[] } | null> {
  requireOrgAdmin(context);
  const [{ rows }, groups] = await Promise.all([
    db.query<{
      username: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      secondary_email: string | null;
      phone: string | null;
      role: string | null;
      expiry_date: string | null;
      disabled: boolean;
      ldap_groups: string[];
      github_username: string | null;
      slack_username: string | null;
    }>(`
      SELECT u.username, u.first_name, u.last_name, u.email, u.secondary_email, u.phone, u.role,
             TO_CHAR(u.expiry_date, 'YYYY-MM-DD') AS expiry_date, u.disabled, u.ldap_groups,
             u.github_username, u.slack_username
      FROM users u
      JOIN user_orgs uo ON uo.username = u.username AND uo.org_id = $2
      WHERE u.username = $1
    `, [username, context.org.id]),
    listOrgGroups(context),
  ]);
  const row = rows[0];
  if (!row) return null;
  const ldapUser = await ldap.getUser(username).catch(() => null);
  return {
    person: {
      username: row.username,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      secondaryEmail: row.secondary_email,
      phone: row.phone,
      role: row.role,
      expiryDate: row.expiry_date,
      disabled: row.disabled,
      ldapGroups: row.ldap_groups ?? [],
      githubUsername: row.github_username,
      slackUsername: row.slack_username,
      sshPublicKeys: ldapUser?.sshPublicKeys ?? [],
    },
    groups,
  };
}

export async function searchDirectoryPeople(
  context: RosterUiContext,
  rawQuery: string,
): Promise<PersonSearchResult[]> {
  const query = rawQuery.trim();
  if (!query) return [];

  const { rows } = await db.query<{
    username: string;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    org_role: string | null;
    is_directory_admin: boolean;
    ldap_groups: string[];
  }>(`
    SELECT u.username, u.first_name, u.last_name, u.email, uo.role AS org_role, u.ldap_groups,
           COALESCE($3 = ANY(u.ldap_groups), false) AS is_directory_admin
    FROM users u
    LEFT JOIN user_orgs uo ON uo.username = u.username AND uo.org_id = $2
    WHERE u.username ILIKE '%' || $1 || '%'
       OR u.email ILIKE '%' || $1 || '%'
       OR u.first_name ILIKE '%' || $1 || '%'
       OR u.last_name ILIKE '%' || $1 || '%'
       OR CONCAT_WS(' ', u.first_name, u.last_name) ILIKE '%' || $1 || '%'
    ORDER BY
      CASE
        WHEN LOWER(u.username) = LOWER($1) THEN 0
        WHEN LOWER(u.email) = LOWER($1) THEN 1
        WHEN LOWER(u.username) LIKE LOWER($1) || '%' THEN 2
        WHEN LOWER(u.email) LIKE LOWER($1) || '%' THEN 3
        WHEN LOWER(u.last_name) LIKE LOWER($1) || '%' THEN 4
        WHEN LOWER(u.first_name) LIKE LOWER($1) || '%' THEN 5
        ELSE 6
      END,
      u.last_name NULLS LAST, u.first_name NULLS LAST, u.username
    LIMIT 20
  `, [query, context.org.id, process.env.ADMIN_GROUP ?? 'e4e-admin']);

  return rows.map((row) => ({
    username: row.username,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    orgRole: row.org_role,
    isDirectoryAdmin: row.is_directory_admin,
    ldapGroups: row.ldap_groups ?? [],
  }));
}

export async function searchPeople(
  context: RosterUiContext,
  rawQuery: string,
): Promise<PersonSearchResult[]> {
  requireOrgAdmin(context);
  return searchDirectoryPeople(context, rawQuery);
}
