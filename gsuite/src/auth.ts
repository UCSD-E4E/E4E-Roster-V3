/**
 * Google service account auth with domain-wide delegation.
 *
 * Setup (one-time, in Google Cloud Console + Google Workspace Admin):
 *   1. Create a service account, enable domain-wide delegation.
 *   2. Download the JSON key; set GOOGLE_SERVICE_ACCOUNT_KEY_PATH to its path.
 *   3. In Google Workspace Admin → Security → API Controls → Domain-wide Delegation,
 *      add the service account's client ID with the scope:
 *        https://www.googleapis.com/auth/admin.directory.group
 *   4. Set GOOGLE_ADMIN_EMAIL to a Google Workspace admin user to impersonate
 *      (e.g. e4e@ucsd.edu). This account is used as the "subject" for delegation.
 */
import { google, Auth } from 'googleapis';
import fs from 'fs';

const SCOPES = [
  // Read-only on groups (needed to list groups for the admin UI dropdown)
  'https://www.googleapis.com/auth/admin.directory.group.readonly',
  // Write on members only (needed to add users to groups — cannot create/delete groups)
  'https://www.googleapis.com/auth/admin.directory.group.member',
];

let _auth: Auth.JWT | null = null;

export function getAuth(): Auth.JWT {
  if (_auth) return _auth;

  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;
  const adminEmail = process.env.GOOGLE_ADMIN_EMAIL;

  if (!keyPath) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_PATH is not set');
  if (!adminEmail) throw new Error('GOOGLE_ADMIN_EMAIL is not set');

  const key = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as {
    client_email: string;
    private_key: string;
  };

  _auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SCOPES,
    subject: adminEmail, // Impersonate this admin to access Directory API
  });

  return _auth;
}
