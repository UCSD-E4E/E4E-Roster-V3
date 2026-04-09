/**
 * Univention UDM REST API service.
 * Docs: https://<your-host>/univention/udm/ (interactive API browser)
 */
import crypto from 'crypto';
import { NewUser, ProvisionResult, SystemStatus } from './types';

interface UdmObject {
  dn: string;
  properties: Record<string, unknown>;
}

interface UdmCollection {
  _embedded?: { 'udm:object'?: UdmObject[] };
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

async function udmFetch(path: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers as Record<string, string>),
    },
  });
}

function generateTempPassword(): string {
  return crypto.randomBytes(12).toString('base64url');
}

// ── Exported service functions ────────────────────────────────────

export async function checkUser(username: string): Promise<SystemStatus> {
  const res = await udmFetch(
    `/users/user/?filter=${encodeURIComponent(`uid=${username}`)}`,
  );
  if (!res.ok) throw new Error(`UDM error ${res.status}: ${res.statusText}`);
  const data: UdmCollection = await res.json();
  const objects = data._embedded?.['udm:object'] ?? [];
  return {
    exists: objects.length > 0,
    details: objects[0] ? { dn: objects[0].dn } : undefined,
  };
}

export async function listGroups(): Promise<string[]> {
  const res = await udmFetch('/groups/group/?properties=name&page_size=500');
  if (!res.ok) throw new Error(`UDM error ${res.status}: ${res.statusText}`);
  const data: UdmCollection = await res.json();
  return (data._embedded?.['udm:object'] ?? [])
    .map((g) => g.properties.name as string)
    .filter(Boolean)
    .sort();
}

async function addToGroup(userDn: string, groupName: string): Promise<void> {
  // Find the group
  const searchRes = await udmFetch(
    `/groups/group/?filter=${encodeURIComponent(`cn=${groupName}`)}&properties=users`,
  );
  if (!searchRes.ok) throw new Error(`Failed to find group "${groupName}": ${searchRes.statusText}`);
  const searchData: UdmCollection = await searchRes.json();
  const group = searchData._embedded?.['udm:object']?.[0];
  if (!group) throw new Error(`Group "${groupName}" not found`);

  const currentMembers = (group.properties.users as string[]) ?? [];
  if (currentMembers.includes(userDn)) return; // Already a member

  // Fetch the individual resource to get its ETag for the PATCH
  const getRes = await udmFetch(`/groups/group/${encodeURIComponent(group.dn)}`);
  const etag = getRes.headers.get('etag') ?? '*';

  const patchRes = await udmFetch(`/groups/group/${encodeURIComponent(group.dn)}`, {
    method: 'PATCH',
    headers: { 'If-Match': etag },
    body: JSON.stringify({
      properties: { users: [...currentMembers, userDn] },
    }),
  });
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

  const res = await udmFetch('/users/user/', {
    method: 'POST',
    body: JSON.stringify({
      properties: {
        username: user.username,
        firstname: user.firstName,
        lastname: user.lastName,
        password: tempPassword,
        mailPrimaryAddress: user.email,
      },
      position,
    }),
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const err = await res.json() as Record<string, unknown>;
      message = (err['error'] as string) || (err['message'] as string) || message;
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
