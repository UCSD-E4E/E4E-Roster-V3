import passport from 'passport';
import { Client, Strategy, TokenSet, UserinfoResponse } from 'openid-client';
import { AuthUser, OrgMembership, OrgRole } from './types/user';
import { db, getAllOrgLdapMappings, getUserOrgMemberships, upsertUserOrgMembership } from './services/db';


export function setupPassport(client: Client): void {
  passport.use(
    'oidc',
    new Strategy(
      { client, params: { scope: 'openid profile email groups' } },
      async (
        _tokenSet: TokenSet,
        userinfo: UserinfoResponse,
        done: (err: Error | null, user?: AuthUser) => void,
      ) => {
        try {
          console.log('[auth] tokenSet received, idToken claims:', JSON.stringify(_tokenSet.claims(), null, 2));
          console.log('[auth] userinfo from Authentik:', JSON.stringify(userinfo, null, 2));

          const groups = ((userinfo as Record<string, unknown>).groups as string[]) ?? [];
          const systemAdminGroup = process.env.SYSTEM_ADMIN_GROUP ?? 'system-admin';
          const username = (userinfo.preferred_username as string) ?? userinfo.sub;

          const orgs = await buildOrgMemberships(username, groups);

          const user: AuthUser = {
            id: userinfo.sub,
            name: (userinfo.name as string) ?? '',
            email: (userinfo.email as string) ?? '',
            username,
            groups,
            isSystemAdmin: groups.includes(systemAdminGroup),
            orgs,
          };

          return done(null, user);
        } catch (err) {
          return done(err as Error);
        }
      },
    ),
  );

  passport.serializeUser((user: Express.User, done) => {
    done(null, user);
  });

  passport.deserializeUser((user: Express.User, done) => {
    done(null, user);
  });
}

// Derives org memberships from LDAP groups, upserts them to user_orgs, then
// merges any manually-assigned memberships that LDAP groups don't cover.
// LDAP groups are the source of truth — if a user matches a configured mapping
// their DB row is updated to match on every login.
async function buildOrgMemberships(
  username: string,
  ldapGroups: string[],
): Promise<OrgMembership[]> {
  // All configured LDAP group → org role mappings across every org
  const allMappings = await getAllOrgLdapMappings();

  // Role priority: org_admin > project_lead > member
  // utility groups are tracked but intentionally excluded — they do not grant org membership.
  const rolePriority: Record<OrgRole, number> = { org_admin: 3, project_lead: 2, member: 1 };

  // Determine the highest role the user qualifies for in each org via LDAP groups
  const ldapDerived = new Map<number, OrgRole>();
  for (const mapping of allMappings) {
    if (!ldapGroups.includes(mapping.ldap_group)) continue;
    if (mapping.role === 'utility') continue;
    const role = mapping.role as OrgRole;
    const existing = ldapDerived.get(mapping.org_id);
    if (!existing || rolePriority[role] > rolePriority[existing]) {
      ldapDerived.set(mapping.org_id, role);
    }
  }

  // Upsert LDAP-derived memberships — only if the user row exists in DB
  // (sync may not have run yet for brand-new SSO users)
  const { rowCount } = await db.query('SELECT 1 FROM users WHERE username = $1', [username]);
  if (rowCount && rowCount > 0) {
    for (const [orgId, role] of ldapDerived) {
      await upsertUserOrgMembership(username, orgId, role);
    }
  }

  // Fetch all DB memberships (includes manually granted ones not covered by LDAP groups)
  const dbRows = await getUserOrgMemberships(username);

  // Seed merged map from DB, then let LDAP-derived roles win where they exist
  const merged = new Map<number, OrgMembership>();
  for (const row of dbRows) {
    merged.set(row.org_id, {
      orgId: row.org_id,
      orgSlug: row.org_slug,
      orgName: row.org_name,
      role: row.role as OrgRole,
    });
  }
  for (const [orgId, role] of ldapDerived) {
    const existing = merged.get(orgId);
    if (existing) {
      merged.set(orgId, { ...existing, role });
    }
  }

  return Array.from(merged.values());
}
