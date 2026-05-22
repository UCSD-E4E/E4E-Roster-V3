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

// ── LDAP client ───────────────────────────────────────────────────

function ldapClient(): Client {
  return new Client({
    url: process.env.LDAP_URL!,
    connectTimeout: 5000,
    // Self-signed cert — matches how Authentik connects to this server.
    tlsOptions: { rejectUnauthorized: false },
  });
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = ldapClient();
  try {
    const t0 = Date.now();
    await client.bind(process.env.LDAP_BIND_DN!, process.env.LDAP_BIND_PASSWORD!);
    console.log(`[ldap] bind: ${Date.now() - t0}ms`);
    return await fn(client);
  } finally {
    await client.unbind();
  }
}

// ── DN helpers ────────────────────────────────────────────────────

function groupDN(groupCN: string): string {
  return `CN=${groupCN},${process.env.LDAP_GROUPS_DN}`;
}

/** Look up a user's DN within an existing open connection. Returns null if not found. */
async function getUserDN(client: Client, username: string): Promise<string | null> {
  const { searchEntries } = await client.search(process.env.LDAP_USERS_DN!, {
    scope: 'sub',
    filter: `(sAMAccountName=${username})`,
    attributes: ['dn'],
  });
  return searchEntries.length ? searchEntries[0].dn : null;
}

// ── Misc helpers ──────────────────────────────────────────────────

function generateTempPassword(): string {
  return crypto.randomBytes(12).toString('base64url');
}

// Samba4 AD uses Windows FILETIME: 100-ns ticks since 1601-01-01 UTC.
// 0 and 9223372036854775807 both mean "never expires".
function fileTimeToISO(filetime: string): string | null {
  const val = BigInt(filetime);
  if (val === 0n || val === 9223372036854775807n) return null;
  const unixMs = Number((val - 116444736000000000n) / 10000n);
  return new Date(unixMs).toISOString().split('T')[0];
}

function isoToFileTime(isoDate: string): string {
  const unixMs = new Date(isoDate).getTime();
  const filetime = BigInt(unixMs) * 10000n + 116444736000000000n;
  return filetime.toString();
}

// userAccountControl bit 0x2 = disabled; 512 = normal enabled account
function isDisabled(uac: string | undefined): boolean {
  return (parseInt(uac ?? '0', 10) & 0x2) !== 0;
}

function groupCNsFromMemberOf(memberOf: unknown): string[] {
  const raw = memberOf ?? [];
  return (Array.isArray(raw) ? raw : [raw])
    .filter(Boolean)
    .map((dn) => {
      const m = (dn as string).match(/^CN=([^,]+)/i);
      return m ? m[1] : (dn as string);
    });
}

// ── LdapUser type + entry mapping ────────────────────────────────

export interface LdapUser {
  dn: string;
  username: string;          // sAMAccountName
  firstName: string;         // givenName
  lastName: string;          // sn
  email: string;             // mail
  disabled: boolean;         // userAccountControl & 0x2
  groups: string[];          // memberOf CNs
  expiryDate: string | null; // accountExpires → ISO date, null = never
  sshPublicKeys: string[];   // sshPublicKey (OpenSSH-LPK schema extension)
}

const USER_ATTRS = [
  'sAMAccountName', 'givenName', 'sn', 'mail',
  'userAccountControl', 'memberOf', 'accountExpires', 'sshPublicKey',
];

function entryToUser(e: { dn: string; [k: string]: unknown }): LdapUser {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    dn: e.dn,
    username: str(e.sAMAccountName),
    firstName: str(e.givenName),
    lastName: str(e.sn),
    email: str(e.mail),
    disabled: isDisabled(e.userAccountControl as string),
    groups: groupCNsFromMemberOf(e.memberOf),
    expiryDate: e.accountExpires ? fileTimeToISO(e.accountExpires as string) : null,
    sshPublicKeys: e.sshPublicKey
      ? (Array.isArray(e.sshPublicKey) ? e.sshPublicKey : [e.sshPublicKey]) as string[]
      : [],
  };
}

// ── Read operations ───────────────────────────────────────────────

export async function listUsers(): Promise<LdapUser[]> {
  return withClient(async (client) => {
    const t1 = Date.now();
    const { searchEntries } = await client.search(process.env.LDAP_USERS_DN!, {
      scope: 'sub',
      filter: '(&(objectClass=user)(!(objectClass=computer)))',
      attributes: USER_ATTRS,
    });
    console.log(`[ldap] search: ${Date.now() - t1}ms, ${searchEntries.length} users`);
    return searchEntries.map(entryToUser);
  });
}

export async function getUser(username: string): Promise<LdapUser | null> {
  return withClient(async (client) => {
    const { searchEntries } = await client.search(process.env.LDAP_USERS_DN!, {
      scope: 'sub',
      filter: `(sAMAccountName=${username})`,
      attributes: USER_ATTRS,
    });
    return searchEntries.length ? entryToUser(searchEntries[0]) : null;
  });
}

export async function checkUser(username: string): Promise<SystemStatus> {
  return withClient(async (client) => {
    const { searchEntries } = await client.search(process.env.LDAP_USERS_DN!, {
      scope: 'sub',
      filter: `(sAMAccountName=${username})`,
      attributes: ['sAMAccountName', 'mail', 'cn'],
    });
    const entry = searchEntries[0];
    return {
      exists: searchEntries.length > 0,
      details: entry ? { dn: entry.dn, mail: entry.mail } : undefined,
    };
  });
}

export async function listGroups(): Promise<string[]> {
  return withClient(async (client) => {
    const { searchEntries } = await client.search(process.env.LDAP_GROUPS_DN!, {
      scope: 'sub',
      filter: '(objectClass=group)',
      attributes: ['cn'],
    });
    console.log(`[ldap] found ${searchEntries.length} groups`);
    return searchEntries.map((e) => e.cn as string).filter(Boolean).sort();
  });
}

// ── Create operations ─────────────────────────────────────────────

export async function createGroup(name: string): Promise<ProvisionResult> {
  const existing = await listGroups();
  if (existing.includes(name)) {
    return { status: 'already_exists', message: `Group "${name}" already exists` };
  }
  try {
    await withClient(async (client) => {
      await client.add(groupDN(name), {
        objectClass: ['top', 'group'],
        cn: name,
        sAMAccountName: name,
        groupType: '-2147483646', // Global security group
      });
    });
    return { status: 'success', message: `Created group "${name}"` };
  } catch (err: unknown) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
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
      const displayName = `${user.firstName} ${user.lastName}`;
      const newDN = `CN=${displayName},${process.env.LDAP_USERS_DN!}`;

      // Step 1: create account disabled with no password required.
      // Samba4 rejects unicodePwd in the same add() call — password must be
      // set in a separate modify after the entry exists.
      await client.add(newDN, {
        objectClass: ['top', 'person', 'organizationalPerson', 'user'],
        cn: displayName,
        sn: user.lastName,
        givenName: user.firstName,
        sAMAccountName: user.username,
        userPrincipalName: `${user.username}@${process.env.LDAP_DOMAIN!}`,
        mail: user.email,
        userAccountControl: '514', // NORMAL_ACCOUNT | ACCOUNTDISABLE (enabled after password is set)
        accountExpires: isoToFileTime(user.expiryDate),
      });

      // Step 2: set the password (requires LDAPS; wrapped in double-quotes, UTF-16LE)
      const encodedPassword = Buffer.from(`"${tempPassword}"`, 'utf16le');
      await client.modify(newDN, [
        new Change({
          operation: 'replace',
          modification: new Attribute({ type: 'unicodePwd', values: [encodedPassword as unknown as string] }),
        }),
      ]);

      // Step 3: enable the account now that the password is set
      await client.modify(newDN, [
        new Change({
          operation: 'replace',
          modification: new Attribute({ type: 'userAccountControl', values: ['512'] }),
        }),
      ]);

      for (const group of user.ldapGroups) {
        try {
          await client.modify(groupDN(group), [
            new Change({
              operation: 'add',
              modification: new Attribute({ type: 'member', values: [newDN] }),
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
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

// ── SSH key helpers ───────────────────────────────────────────────

function validateEd25519Key(key: string): string | null {
  return key.trimStart().startsWith('ssh-ed25519 ')
    ? null
    : 'Only ed25519 keys are accepted (key must start with "ssh-ed25519 ")';
}

/** Attach the ldapPublicKey aux class — safe to call when already present. */
async function ensureSshAuxClass(client: Client, dn: string): Promise<void> {
  try {
    await client.modify(dn, [
      new Change({
        operation: 'add',
        modification: new Attribute({ type: 'objectClass', values: ['ldapPublicKey'] }),
      }),
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.toLowerCase().includes('already exists') && !msg.includes('20')) throw err;
  }
}

// ── Modify operations (single connection each) ────────────────────

export async function updateUserExpiry(
  username: string,
  expiryDate: string | null,
): Promise<ProvisionResult> {
  try {
    return await withClient(async (client) => {
      const dn = await getUserDN(client, username);
      if (!dn) return { status: 'failed', message: `User ${username} not found` };
      // 0 = never expires in Samba4 AD
      await client.modify(dn, [
        new Change({
          operation: 'replace',
          modification: new Attribute({
            type: 'accountExpires',
            values: [expiryDate ? isoToFileTime(expiryDate) : '0'],
          }),
        }),
      ]);
      return { status: 'success', message: `Updated expiry for ${username}` };
    });
  } catch (err: unknown) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function updateUserGroups(
  username: string,
  groupNames: string[],
): Promise<ProvisionResult> {
  try {
    return await withClient(async (client) => {
      const { searchEntries } = await client.search(process.env.LDAP_USERS_DN!, {
        scope: 'sub',
        filter: `(sAMAccountName=${username})`,
        attributes: ['dn', 'memberOf'],
      });
      if (!searchEntries.length) return { status: 'failed', message: `User ${username} not found` };

      const dn = searchEntries[0].dn;
      const currentGroups = groupCNsFromMemberOf(searchEntries[0].memberOf);
      const toAdd = groupNames.filter((g) => !currentGroups.includes(g));
      const toRemove = currentGroups.filter((g) => !groupNames.includes(g));

      for (const group of toAdd) {
        await client.modify(groupDN(group), [
          new Change({ operation: 'add', modification: new Attribute({ type: 'member', values: [dn] }) }),
        ]);
      }
      for (const group of toRemove) {
        await client.modify(groupDN(group), [
          new Change({ operation: 'delete', modification: new Attribute({ type: 'member', values: [dn] }) }),
        ]);
      }
      return { status: 'success', message: `Updated groups for ${username}` };
    });
  } catch (err: unknown) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function addUserToGroup(username: string, groupName: string): Promise<ProvisionResult> {
  try {
    return await withClient(async (client) => {
      const dn = await getUserDN(client, username);
      if (!dn) return { status: 'failed', message: `User ${username} not found` };
      await client.modify(groupDN(groupName), [
        new Change({ operation: 'add', modification: new Attribute({ type: 'member', values: [dn] }) }),
      ]);
      return { status: 'success', message: `Added ${username} to ${groupName}` };
    });
  } catch (err: unknown) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function removeUserFromGroup(username: string, groupName: string): Promise<ProvisionResult> {
  try {
    return await withClient(async (client) => {
      const dn = await getUserDN(client, username);
      if (!dn) return { status: 'failed', message: `User ${username} not found` };
      await client.modify(groupDN(groupName), [
        new Change({ operation: 'delete', modification: new Attribute({ type: 'member', values: [dn] }) }),
      ]);
      return { status: 'success', message: `Removed ${username} from ${groupName}` };
    });
  } catch (err: unknown) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function addSshKey(username: string, publicKey: string): Promise<ProvisionResult> {
  const keyError = validateEd25519Key(publicKey);
  if (keyError) return { status: 'failed', message: keyError };
  try {
    return await withClient(async (client) => {
      const dn = await getUserDN(client, username);
      if (!dn) return { status: 'failed', message: `User ${username} not found` };
      await ensureSshAuxClass(client, dn);
      await client.modify(dn, [
        new Change({ operation: 'add', modification: new Attribute({ type: 'sshPublicKey', values: [publicKey] }) }),
      ]);
      return { status: 'success', message: `Added SSH key for ${username}` };
    });
  } catch (err: unknown) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

export async function setSshKeys(username: string, publicKeys: string[]): Promise<ProvisionResult> {
  for (const key of publicKeys) {
    const keyError = validateEd25519Key(key);
    if (keyError) return { status: 'failed', message: `Invalid key "${key.slice(0, 30)}...": ${keyError}` };
  }
  try {
    return await withClient(async (client) => {
      const dn = await getUserDN(client, username);
      if (!dn) return { status: 'failed', message: `User ${username} not found` };
      await ensureSshAuxClass(client, dn);
      await client.modify(dn, [
        new Change({ operation: 'replace', modification: new Attribute({ type: 'sshPublicKey', values: publicKeys }) }),
      ]);
      return { status: 'success', message: `Set ${publicKeys.length} SSH key(s) for ${username}` };
    });
  } catch (err: unknown) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

// TODO: re-enable once extended attribute strategy is decided (Exchange schema vs custom attributes)
/*
export async function updateUserLdapFields(
  username: string,
  fields: {
    slackId?: string | null;
    githubUsername?: string | null;
    role?: string | null;
    secondaryEmail?: string | null;
    phone?: string | null;
  },
): Promise<ProvisionResult> {
  const changes: Change[] = [];

  const addChange = (attr: string, value: string | null) => {
    changes.push(
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: attr, values: value ? [value] : [] }),
      }),
    );
  };

  if (fields.slackId !== undefined) addChange('extensionAttribute1', fields.slackId ?? null);
  if (fields.githubUsername !== undefined) addChange('extensionAttribute2', fields.githubUsername ?? null);
  if (fields.role !== undefined) addChange('extensionAttribute3', fields.role ?? null);
  if (fields.secondaryEmail !== undefined) addChange('extensionAttribute4', fields.secondaryEmail ?? null);
  if (fields.phone !== undefined) addChange('mobile', fields.phone ?? null);

  if (changes.length === 0) return { status: 'success', message: 'No fields to update' };

  try {
    return await withClient(async (client) => {
      const dn = await getUserDN(client, username);
      if (!dn) return { status: 'failed', message: `User ${username} not found` };
      await client.modify(dn, changes);
      return { status: 'success', message: `Updated LDAP fields for ${username}` };
    });
  } catch (err: unknown) {
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}
*/
