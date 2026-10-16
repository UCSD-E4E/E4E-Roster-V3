import { db } from '../services/db';

// Read-only preflight for the staged membership cleanup.  This intentionally
// does not decide whether a missing row should be backfilled: that policy
// depends on the still-open manual-vs-LDAP membership provenance decision.
async function main(): Promise<void> {
  const [missingOrgMemberships, unownedProjectGroups, projectsWithoutOrg] = await Promise.all([
    db.query<{
      org_slug: string;
      project_id: number;
      project_name: string;
      username: string;
      matching_groups: string[];
    }>(`
      SELECT o.slug AS org_slug, p.id AS project_id, p.name AS project_name, u.username,
             ARRAY_AGG(DISTINCT plg.ldap_group ORDER BY plg.ldap_group) AS matching_groups
      FROM projects p
      JOIN orgs o ON o.id = p.org_id
      JOIN project_ldap_groups plg ON plg.project_id = p.id
      JOIN users u ON plg.ldap_group = ANY(u.ldap_groups)
      LEFT JOIN user_orgs uo ON uo.username = u.username AND uo.org_id = p.org_id
      WHERE uo.username IS NULL
      GROUP BY o.slug, p.id, p.name, u.username
      ORDER BY o.slug, p.name, u.username
    `),
    db.query<{
      org_slug: string;
      project_id: number;
      project_name: string;
      ldap_group: string;
    }>(`
      SELECT o.slug AS org_slug, p.id AS project_id, p.name AS project_name, plg.ldap_group
      FROM projects p
      JOIN orgs o ON o.id = p.org_id
      JOIN project_ldap_groups plg ON plg.project_id = p.id
      LEFT JOIN org_groups og ON og.org_id = p.org_id AND og.ldap_group = plg.ldap_group
      WHERE og.ldap_group IS NULL
      ORDER BY o.slug, p.name, plg.ldap_group
    `),
    db.query<{ project_id: number; project_name: string }>(`
      SELECT id AS project_id, name AS project_name
      FROM projects
      WHERE org_id IS NULL
      ORDER BY name
    `),
  ]);

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    missingOrgMemberships: missingOrgMemberships.rows,
    unownedProjectGroups: unownedProjectGroups.rows,
    projectsWithoutOrg: projectsWithoutOrg.rows,
  }, null, 2));
}

main()
  .catch((err: unknown) => {
    console.error('Membership reconciliation report failed:', err);
    process.exitCode = 1;
  })
  .finally(() => db.end());
