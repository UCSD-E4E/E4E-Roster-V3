import passport from 'passport';
import { Client, Strategy, TokenSet, UserinfoResponse } from 'openid-client';
import { AuthUser, OrgRole } from './types/user';
import { isSystemAdmin, getAllOrgLdapMappings, getAllOrgs } from './services/db';

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
          console.log('[auth] userinfo from Authentik:', JSON.stringify(userinfo, null, 2));

          const groups =
            ((userinfo as Record<string, unknown>).groups as string[]) ?? [];
          const plGroup = process.env.PL_GROUP_NAME ?? '';

          const [sysAdmin, allMappings, allOrgs] = await Promise.all([
            isSystemAdmin(groups),
            getAllOrgLdapMappings(),
            getAllOrgs(),
          ]);

          // Derive highest role per org from LDAP group memberships
          const roleRank = { org_admin: 3, project_lead: 2, member: 1 };
          const orgRoleMap = new Map<number, OrgRole>();
          for (const m of allMappings) {
            if (!groups.includes(m.ldap_group)) continue;
            const existing = orgRoleMap.get(m.org_id);
            const newRank = roleRank[m.role as keyof typeof roleRank] ?? 0;
            const curRank = existing ? (roleRank[existing.role] ?? 0) : 0;
            if (newRank > curRank) {
              const org = allOrgs.find(o => o.id === m.org_id);
              if (org) orgRoleMap.set(m.org_id, {
                orgId: org.id,
                orgSlug: org.slug,
                orgName: org.name,
                themeColor: org.theme_color,
                role: m.role as OrgRole['role'],
              });
            }
          }

          const user: AuthUser = {
            id: userinfo.sub,
            name: (userinfo.name as string) ?? '',
            email: (userinfo.email as string) ?? '',
            username: (userinfo.preferred_username as string) ?? userinfo.sub,
            groups,
            isAdmin: sysAdmin,
            isSystemAdmin: sysAdmin,
            isProjectLead: plGroup !== '' && groups.includes(plGroup),
            orgRoles: Array.from(orgRoleMap.values()),
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
