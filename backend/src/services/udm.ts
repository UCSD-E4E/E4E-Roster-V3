/**
 * Univention UDM REST API service.
 * Docs: https://<your-host>/univention/udm/ (interactive API browser)
 */
import crypto from 'crypto';
import https from 'https';
import { NewUser, ProvisionResult, SystemStatus } from './types';

// rejectUnauthorized:false matches how Authentik connects to this server
const tlsAgent = new https.Agent({ rejectUnauthorized: false });

interface UdmObject {
  dn: string;
  properties: Record<string, unknown>;
}

interface UdmCollection {
  _embedded?: { 'udm:object'?: UdmObject[] };
}

// Minimal Response-like wrapper returned by udmFetch
interface UdmResponse {
  status: number;
  statusText: string;
  ok: boolean;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

function baseUrl(): string {
  return process.env.UDM_URL!.replace(/\/$/, '');
}

function authHeader(): string {
  const creds = Buffer.from(
    `${process.env.UDM_ADMIN_USER}:${process.env.UDM_ADMIN_PASSWORD}`,
  ).toString('base64');
  return `Basic ${creds}`;
}

function httpsRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<UdmResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqHeaders: Record<string, string> = { ...headers };
    if (body) reqHeaders['Content-Length'] = Buffer.byteLength(body).toString();

    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parseInt(parsed.port) || 443,
        path: parsed.pathname + parsed.search,
        method,
        agent: tlsAgent,
        headers: reqHeaders,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          const statusText = res.statusMessage ?? '';
          const resHeaders = res.headers;
          resolve({
            status,
            statusText,
            ok: status >= 200 && status < 300,
            headers: { get: (name) => (resHeaders[name.toLowerCase()] as string) ?? null },
            text: () => Promise.resolve(raw),
            json: () => Promise.resolve(JSON.parse(raw)),
          });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function udmFetch(
  path: string,
  method = 'GET',
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<UdmResponse> {
  const headers: Record<string, string> = {
    Authorization: authHeader(),
    Accept: 'application/json',
    ...extraHeaders,
  };
  if (body) headers['Content-Type'] = 'application/json';

  const url = `${baseUrl()}${path}`;
  console.log(`[udm] ${method} ${url}`);

  const res = await httpsRequest(url, method, headers, body);

  console.log(`[udm] response: ${res.status} ${res.statusText}`);
  if (!res.ok) {
    const text = await res.text();
    console.log(`[udm] error body:`, text.slice(0, 500));
    const captured = text;
    return { ...res, text: () => Promise.resolve(captured), json: () => Promise.resolve(JSON.parse(captured)) };
  }

  return res;
}

function generateTempPassword(): string {
  return crypto.randomBytes(12).toString('base64url');
}

// ── Extended attribute helpers ────────────────────────────────────

/** Extract the base DC portion from UDM_USERS_POSITION (e.g. dc=example,dc=com). */
function baseDn(): string {
  const pos = process.env.UDM_USERS_POSITION ?? '';
  const m = pos.match(/(dc=.+)$/i);
  return m ? m[1] : pos;
}

const EXTENDED_ATTRS = [
  {
    name: 'e4eSlackId',
    ldapMapping: 'univentionFreeAttribute1',
    shortDescription: 'E4E Slack Member ID',
    longDescription: 'Stable Slack member ID (U...) for the E4E workspace',
  },
  {
    name: 'e4eGithubUsername',
    ldapMapping: 'univentionFreeAttribute2',
    shortDescription: 'E4E GitHub Username',
    longDescription: 'GitHub username for the UCSD-E4E organization',
  },
  {
    name: 'LabRole',
    ldapMapping: 'univentionFreeAttribute3',
    shortDescription: 'E4E Lab Role',
    longDescription: 'Role within the E4E lab (e.g. student, staff)',
  },
];

/**
 * Idempotently creates the two UDM extended attributes (e4eSlackId, e4eGithubUsername)
 * on the users/user module using univentionFreeAttribute slots.
 * Safe to call on every startup — skips any that already exist.
 */
export async function ensureExtendedAttributes(): Promise<void> {
  const position = `cn=custom attributes,cn=univention,${baseDn()}`;

  for (const attr of EXTENDED_ATTRS) {
    const checkRes = await udmFetch(
      `/settings/extended_attribute/?filter=${encodeURIComponent(`name=${attr.name}`)}`,
    );
    if (!checkRes.ok) {
      console.warn(`[udm] cannot check extended attribute ${attr.name}: ${checkRes.status}`);
      continue;
    }
    const data = await checkRes.json() as UdmCollection;
    if ((data._embedded?.['udm:object'] ?? []).length > 0) {
      console.log(`[udm] extended attribute ${attr.name} already exists, skipping`);
      continue;
    }

    const createRes = await udmFetch(
      '/settings/extended_attribute/',
      'POST',
      JSON.stringify({
        position,
        properties: {
          name: attr.name,
          module: ['users/user'],
          ldapMapping: attr.ldapMapping,
          objectClass: 'univentionFreeAttributes',
          syntax: 'string',
          shortDescription: attr.shortDescription,
          longDescription: attr.longDescription,
          tabName: 'E4E',
          tabPosition: 1,
          groupName: 'E4E Integration',
          groupPosition: 1,
          deleteObjectClass: false,
          overwriteTab: false,
          fullWidth: false,
          notEditable: false,
          mayChange: true,
          multivalue: false,
          valueRequired: false,
          CLIName: attr.name,
          version: '2',
        },
      }),
    );

    if (createRes.ok || createRes.status === 201) {
      console.log(`[udm] created extended attribute ${attr.name}`);
    } else {
      const text = await createRes.text();
      console.warn(`[udm] failed to create extended attribute ${attr.name}: ${text.slice(0, 300)}`);
    }
  }
}

// ── Exported service functions ────────────────────────────────────

export async function checkUser(username: string): Promise<SystemStatus> {
  const res = await udmFetch(`/users/user/?filter=${encodeURIComponent(`uid=${username}`)}`);
  if (!res.ok) throw new Error(`UDM error ${res.status}: ${res.statusText}`);
  const data = await res.json() as UdmCollection;
  const objects = data._embedded?.['udm:object'] ?? [];
  return {
    exists: objects.length > 0,
    details: objects[0] ? { dn: objects[0].dn } : undefined,
  };
}

export interface UdmUser {
  dn: string;
  username: string;
  firstName: string;
  lastName: string;
  email: string;
  expiryDate: string | null;    // ISO date string or null
  disabled: boolean;
  groups: string[];             // group CNs
  slackId: string | null;       // e4eSlackId extended attribute
  githubUsername: string | null; // e4eGithubUsername extended attribute
  role: string | null;           // LabRole extended attribute
}

export async function listUsers(): Promise<UdmUser[]> {
  const res = await udmFetch('/users/user/?properties=*&page_size=1000');
  if (!res.ok) throw new Error(`UDM error ${res.status}: ${res.statusText}`);
  const data = await res.json() as UdmCollection;
  const objects = data._embedded?.['udm:object'] ?? [];
  return objects.map((obj) => {
    const p = obj.properties;
    const emailArr = (p['e-mail'] as string[]) ?? [];
    return {
      dn: obj.dn,
      username: (p['username'] as string) || (obj.dn.match(/^uid=([^,]+)/i)?.[1] ?? ''),
      firstName: (p['firstname'] as string) ?? '',
      lastName: (p['lastname'] as string) ?? '',
      email: emailArr[0] ?? (p['mailPrimaryAddress'] as string) ?? '',
      expiryDate: (p['userexpiry'] as string) || null,
      disabled: (p['disabled'] as boolean) ?? false,
      groups: ((p['groups'] as string[]) ?? []).map((dn) => {
        const m = dn.match(/^cn=([^,]+)/i);
        return m ? m[1] : dn;
      }),
      slackId: (p['e4eSlackId'] as string) || null,
      githubUsername: (p['e4eGithubUsername'] as string) || null,
      role: (p['LabRole'] as string) || null,
    };
  });
}

export async function updateUserExpiry(
  username: string,
  expiryDate: string | null,
): Promise<ProvisionResult> {
  const userRes = await udmFetch(`/users/user/?filter=${encodeURIComponent(`uid=${username}`)}&properties=dn`);
  if (!userRes.ok) return { status: 'failed', message: `UDM error ${userRes.status}` };
  const userData = await userRes.json() as UdmCollection;
  const userObj = userData._embedded?.['udm:object']?.[0];
  if (!userObj) return { status: 'failed', message: `User ${username} not found in UDM` };

  const getRes = await udmFetch(`/users/user/${encodeURIComponent(userObj.dn)}`);
  const etag = getRes.headers.get('etag') ?? '*';

  // UDM requires null (not empty string) to clear the expiry field
  const value = expiryDate || null;

  const patchRes = await udmFetch(
    `/users/user/${encodeURIComponent(userObj.dn)}`,
    'PATCH',
    JSON.stringify({ properties: { userexpiry: value } }),
    { 'If-Match': etag },
  );

  if (!patchRes.ok) {
    const text = await patchRes.text();
    return { status: 'failed', message: `Failed to update expiry: ${text.slice(0, 200)}` };
  }
  return { status: 'success', message: `Updated expiry for ${username}` };
}

export async function updateUserGroups(
  username: string,
  groupNames: string[],
): Promise<ProvisionResult> {
  // Find the user DN
  const userRes = await udmFetch(`/users/user/?filter=${encodeURIComponent(`uid=${username}`)}&properties=dn,groups`);
  if (!userRes.ok) return { status: 'failed', message: `UDM error ${userRes.status}` };
  const userData = await userRes.json() as UdmCollection;
  const userObj = userData._embedded?.['udm:object']?.[0];
  if (!userObj) return { status: 'failed', message: `User ${username} not found in UDM` };

  // Get ETag for the user resource
  const getRes = await udmFetch(`/users/user/${encodeURIComponent(userObj.dn)}`);
  const etag = getRes.headers.get('etag') ?? '*';

  // Resolve group names to DNs
  const groupDns = await Promise.all(
    groupNames.map(async (name) => {
      const r = await udmFetch(`/groups/group/?filter=${encodeURIComponent(`cn=${name}`)}&properties=dn`);
      if (!r.ok) return null;
      const d = await r.json() as UdmCollection;
      return d._embedded?.['udm:object']?.[0]?.dn ?? null;
    }),
  );
  const resolvedDns = groupDns.filter((dn): dn is string => dn !== null);

  const patchRes = await udmFetch(
    `/users/user/${encodeURIComponent(userObj.dn)}`,
    'PATCH',
    JSON.stringify({ properties: { groups: resolvedDns } }),
    { 'If-Match': etag },
  );

  if (!patchRes.ok) {
    const text = await patchRes.text();
    return { status: 'failed', message: `Failed to update groups: ${text.slice(0, 200)}` };
  }
  return { status: 'success', message: `Updated groups for ${username}` };
}

/**
 * Write E4E-specific extended attributes back to LDAP.
 * Pass only the fields you want to change; undefined fields are left untouched.
 */
export async function updateUserLdapFields(
  username: string,
  fields: { slackId?: string | null; githubUsername?: string | null; role?: string | null },
): Promise<ProvisionResult> {
  const userRes = await udmFetch(
    `/users/user/?filter=${encodeURIComponent(`uid=${username}`)}&properties=dn`,
  );
  if (!userRes.ok) return { status: 'failed', message: `UDM error ${userRes.status}` };
  const userData = await userRes.json() as UdmCollection;
  const userObj = userData._embedded?.['udm:object']?.[0];
  if (!userObj) return { status: 'failed', message: `User ${username} not found in UDM` };

  const getRes = await udmFetch(`/users/user/${encodeURIComponent(userObj.dn)}`);
  const etag = getRes.headers.get('etag') ?? '*';

  const props: Record<string, string | null> = {};
  if (fields.slackId !== undefined) props['e4eSlackId'] = fields.slackId ?? '';
  if (fields.githubUsername !== undefined) props['e4eGithubUsername'] = fields.githubUsername ?? '';
  if (fields.role !== undefined) props['LabRole'] = fields.role ?? '';

  const patchRes = await udmFetch(
    `/users/user/${encodeURIComponent(userObj.dn)}`,
    'PATCH',
    JSON.stringify({ properties: props }),
    { 'If-Match': etag },
  );

  if (!patchRes.ok) {
    const text = await patchRes.text();
    return { status: 'failed', message: `Failed to update LDAP fields for ${username}: ${text.slice(0, 200)}` };
  }
  return { status: 'success', message: `Updated LDAP fields for ${username}` };
}

export async function createGroup(name: string): Promise<ProvisionResult> {
  const existing = await udmFetch(`/groups/group/?filter=${encodeURIComponent(`cn=${name}`)}&properties=dn`);
  if (existing.ok) {
    const data = await existing.json() as UdmCollection;
    if ((data._embedded?.['udm:object'] ?? []).length > 0) {
      return { status: 'already_exists', message: `Group "${name}" already exists` };
    }
  }

  const position = process.env.UDM_GROUPS_POSITION!;
  const res = await udmFetch(
    '/groups/group/',
    'POST',
    JSON.stringify({ properties: { name }, position }),
  );

  if (res.ok || res.status === 201) {
    return { status: 'success', message: `Created group "${name}"` };
  }
  let message = res.statusText;
  try {
    const err = await res.json() as Record<string, unknown>;
    const errObj = err['error'];
    if (errObj && typeof errObj === 'object') {
      message = (errObj as Record<string, unknown>)['message'] as string || message;
    }
  } catch { /* ignore */ }
  return { status: 'failed', message };
}

export async function listGroups(): Promise<string[]> {
  const res = await udmFetch('/groups/group/?properties=name&page_size=500');
  if (!res.ok) throw new Error(`UDM error ${res.status}: ${res.statusText}`);
  const data = await res.json() as UdmCollection;
  return (data._embedded?.['udm:object'] ?? [])
    .map((g) => g.properties.name as string)
    .filter(Boolean)
    .sort();
}

async function addToGroup(userDn: string, groupName: string): Promise<void> {
  const searchRes = await udmFetch(
    `/groups/group/?filter=${encodeURIComponent(`cn=${groupName}`)}&properties=users`,
  );
  if (!searchRes.ok) throw new Error(`Failed to find group "${groupName}": ${searchRes.statusText}`);
  const searchData = await searchRes.json() as UdmCollection;
  const group = searchData._embedded?.['udm:object']?.[0];
  if (!group) throw new Error(`Group "${groupName}" not found`);

  const currentMembers = (group.properties.users as string[]) ?? [];
  if (currentMembers.includes(userDn)) return;

  const getRes = await udmFetch(`/groups/group/${encodeURIComponent(group.dn)}`);
  const etag = getRes.headers.get('etag') ?? '*';

  const patchRes = await udmFetch(
    `/groups/group/${encodeURIComponent(group.dn)}`,
    'PATCH',
    JSON.stringify({ properties: { users: [...currentMembers, userDn] } }),
    { 'If-Match': etag },
  );
  if (!patchRes.ok) {
    throw new Error(`Failed to add user to "${groupName}": ${patchRes.statusText}`);
  }
}

export async function createUser(
  user: NewUser,
): Promise<ProvisionResult & { tempPassword?: string }> {
  const existing = await checkUser(user.username);
  if (existing.exists) {
    return { status: 'already_exists', message: `${user.username} already exists` };
  }

  const tempPassword = generateTempPassword();
  const position = process.env.UDM_USERS_POSITION!;
  const res = await udmFetch(
    '/users/user/',
    'POST',
    JSON.stringify({
      properties: {
        username: user.username,
        firstname: user.firstName,
        lastname: user.lastName,
        password: tempPassword,
        'e-mail': [user.email],
        mailPrimaryAddress: user.email,
        unixhome: `/home/${user.username}`,
        shell: '/bin/bash',
        primaryGroup: process.env.UDM_PRIMARY_GROUP!,
        userexpiry: user.expiryDate,
      },
      position,
    }),
  );

  if (!res.ok) {
    let message = res.statusText;
    try {
      const err = await res.json() as Record<string, unknown>;
      // UDM wraps errors as { error: { message: "..." } }
      const errObj = err['error'];
      if (errObj && typeof errObj === 'object') {
        message = (errObj as Record<string, unknown>)['message'] as string || message;
      } else if (typeof err['message'] === 'string') {
        message = err['message'] as string;
      }
    } catch { /* ignore parse error */ }
    return { status: 'failed', message };
  }

  const userDn = `uid=${user.username},${position}`;
  const groupErrors: string[] = [];

  for (const group of user.ldapGroups) {
    try {
      await addToGroup(userDn, group);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      groupErrors.push(msg);
      console.warn(`[udm] ${msg}`);
    }
  }

  return {
    status: 'success',
    message: `Created account for ${user.username}${groupErrors.length ? ` (${groupErrors.length} group error(s) — check logs)` : ''}`,
    tempPassword,
    details: { groups: user.ldapGroups, groupErrors },
  };
}
