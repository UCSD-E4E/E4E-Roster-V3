/** Only an explicit Member group in the project's own organization confers membership.
 * Keep this relation shared by project access, rosters, counts and status checks.
 * Resource/utility groups remain in project_ldap_groups for provisioning.
 */
export const projectMembershipGroupsSql = `
  SELECT g.project_id, g.ldap_group, p.org_id
  FROM project_ldap_groups g
  JOIN projects p ON p.id = g.project_id
  JOIN org_ldap_group_mappings m ON m.org_id = p.org_id AND m.ldap_group = g.ldap_group
  WHERE m.role = 'member'
`;
