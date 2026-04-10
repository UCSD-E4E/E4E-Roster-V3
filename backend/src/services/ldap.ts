import { Client, Attribute, Change } from 'ldapts';
import crypto from 'crypto';
import { NewUser, ProvisionResult, SystemStatus } from './types';

/** Generates username: first initial + . + last name + . + 3-digit hash of email
 *  e.g. firstName="Sean", lastName="Perry", email="shperry@ucsd.edu" → s.perry.543
 */
export function generateUsername(firstName: string, lastName: string, email: string): string {
  const digits = parseInt(crypto.createHash('sha512').update(email).digest('hex'), 16) % 999;
  const paddedDigits = digits.toString().padStart(3, '0');
  const first = firstName.trim().replace(/[^a-zA-Z]/g, '')[0].toLowerCase();
  const last = lastName.trim().replace(/[^a-zA-Z]/g, '').toLowerCase();
  return `${first}.${last}.${paddedDigits}`;
}

function ldapClient(): Client {
  return new Client({
    url: process.env.LDAP_URL!,
    // rejectUnauthorized is false to match the server's self-signed cert —
    // the same configuration Authentik uses to connect to this server.
    tlsOptions: { rejectUnauthorized: false },
  });
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = ldapClient();
  try {
    await client.bind(process.env.LDAP_BIND_DN!, process.env.LDAP_BIND_PASSWORD!);
    return await fn(client);
  } finally {
    await client.unbind();
  }
}

function generateTempPassword(): string {
  return crypto.randomBytes(12).toString('base64url');
}

/** Convert ISO date (YYYY-MM-DD) to shadowExpire: days since Unix epoch */
function toShadowExpire(isoDate: string): string {
  const ms = new Date(isoDate).getTime();
  return Math.floor(ms / 86400000).toString();
}

function userDN(username: string): string {
  return `uid=${username},${process.env.LDAP_USERS_DN}`;
}

function groupDN(groupCN: string): string {
  return `cn=${groupCN},${process.env.LDAP_GROUPS_DN}`;
}

export async function checkUser(username: string): Promise<SystemStatus> {
  return withClient(async (client) => {
    const { searchEntries } = await client.search(process.env.LDAP_USERS_DN!, {
      scope: 'sub',
      filter: `(uid=${username})`,
      attributes: ['uid', 'mail', 'cn'],
    });
    const entry = searchEntries[0];
    return {
      exists: searchEntries.length > 0,
      details: entry ? { dn: entry.dn, mail: entry.mail } : undefined,
    };
  });
}

export async function createUser(
  user: NewUser,
): Promise<ProvisionResult & { tempPassword?: string }> {
  const existing = await checkUser(user.username);
  if (existing.exists) {
    return { status: 'already_exists', message: `${user.username} already exists in LDAP` };
  }

  const tempPassword = generateTempPassword();

  try {
    await withClient(async (client) => {
      await client.add(userDN(user.username), {
        objectClass: ['top', 'person', 'organizationalPerson', 'inetOrgPerson'],
        cn: `${user.firstName} ${user.lastName}`,
        sn: user.lastName,
        givenName: user.firstName,
        uid: user.username,
        mail: user.email,
        userPassword: tempPassword,
        shadowExpire: toShadowExpire(user.expiryDate),
      });

      for (const group of user.ldapGroups) {
        try {
          await client.modify(groupDN(group), [
            new Change({
              operation: 'add',
              modification: new Attribute({ type: 'uniqueMember', values: [userDN(user.username)] }),
            }),
          ]);
        } catch (err: unknown) {
          console.warn(`[ldap] Failed to add ${user.username} to group ${group}:`, err);
        }
      }
    });

    return {
      status: 'success',
      message: `Created LDAP account for ${user.username}`,
      tempPassword,
      details: { groups: user.ldapGroups },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', message };
  }
}

export async function listGroups(): Promise<string[]> {
  return withClient(async (client) => {
    const { searchEntries } = await client.search(process.env.LDAP_GROUPS_DN!, {
      scope: 'sub',
      filter: '(&(objectClass=group)(!(isCriticalSystemObject=TRUE)))',
      attributes: ['cn'],
    });
    console.log(`[ldap] found ${searchEntries.length} groups`);
    return searchEntries.map((e) => e.cn as string).filter(Boolean).sort();
  });
}
