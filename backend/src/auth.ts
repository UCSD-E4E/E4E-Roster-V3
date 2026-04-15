import passport from 'passport';
import { Client, Strategy, TokenSet, UserinfoResponse } from 'openid-client';
import { AuthUser } from './types/user';

export function setupPassport(client: Client): void {
  passport.use(
    'oidc',
    new Strategy(
      { client, params: { scope: 'openid profile email groups' } },
      (
        _tokenSet: TokenSet,
        userinfo: UserinfoResponse,
        done: (err: Error | null, user?: AuthUser) => void,
      ) => {
        console.log('[auth] userinfo from Authentik:', JSON.stringify(userinfo, null, 2));

        const groups =
          ((userinfo as Record<string, unknown>).groups as string[]) ?? [];
        const adminGroup = process.env.ADMIN_GROUP ?? 'e4e-admin';
        const plGroup = process.env.PL_GROUP_NAME ?? '';

        const user: AuthUser = {
          id: userinfo.sub,
          name: (userinfo.name as string) ?? '',
          email: (userinfo.email as string) ?? '',
          username: (userinfo.preferred_username as string) ?? userinfo.sub,
          groups,
          isAdmin: groups.includes(adminGroup),
          isProjectLead: plGroup !== '' && groups.includes(plGroup),
        };

        return done(null, user);
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
