/**
 * Google Groups management via the Admin SDK Directory API.
 *
 * All operations are idempotent — already-a-member responses are treated
 * as success so the sync is safe to run repeatedly.
 */
import { google } from 'googleapis';
import { getAuth } from './auth.js';

export interface GoogleGroup {
  id: string;
  email: string;
  name: string;
}

function getDirectory() {
  return google.admin({ version: 'directory_v1', auth: getAuth() });
}

/**
 * List all Google Groups in the configured domain.
 */
export async function listGroups(): Promise<GoogleGroup[]> {
  const domain = process.env.GOOGLE_DOMAIN ?? 'ucsd.edu';
  const dir = getDirectory();
  const groups: GoogleGroup[] = [];
  let pageToken: string | undefined;

  do {
    const res = await dir.groups.list({
      domain,
      maxResults: 200,
      pageToken,
    });
    for (const g of res.data.groups ?? []) {
      if (g.id && g.email && g.name) {
        groups.push({ id: g.id, email: g.email, name: g.name });
      }
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return groups;
}

/**
 * Add a user to a Google Group.
 * Returns 'added', 'already_member', or throws on hard error.
 */
export async function addMember(
  groupEmail: string,
  userEmail: string,
): Promise<'added' | 'already_member'> {
  const dir = getDirectory();
  try {
    await dir.members.insert({
      groupKey: groupEmail,
      requestBody: { email: userEmail, role: 'MEMBER' },
    });
    return 'added';
  } catch (err: unknown) {
    const code = (err as { code?: number }).code;
    const message = (err as { message?: string }).message ?? '';
    // 409 = already a member
    if (code === 409 || message.toLowerCase().includes('already a member')) {
      return 'already_member';
    }
    throw err;
  }
}

/**
 * List current members of a Google Group (emails only).
 */
export async function listMembers(groupEmail: string): Promise<string[]> {
  const dir = getDirectory();
  const emails: string[] = [];
  let pageToken: string | undefined;

  do {
    const res = await dir.members.list({
      groupKey: groupEmail,
      maxResults: 200,
      pageToken,
    });
    for (const m of res.data.members ?? []) {
      if (m.email) emails.push(m.email);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return emails;
}
