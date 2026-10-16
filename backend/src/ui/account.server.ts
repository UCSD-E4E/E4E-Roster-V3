import { db } from '../services/db';
import * as ldap from '../services/ldap';
import { data } from 'react-router';
import type { RosterUiContext } from './projects.server';

export interface AccountProfile {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  secondaryEmail: string | null;
  phone: string | null;
  role: string | null;
  expiryDate: string | null;
  disabled: boolean;
  githubUsername: string | null;
  slackUsername: string | null;
  ldapGroups: string[];
  sshPublicKeys: string[];
}

export async function getAccountProfile(context: RosterUiContext): Promise<AccountProfile | null> {
  const [{ rows }, ldapUser] = await Promise.all([
    db.query<{
      first_name: string | null; last_name: string | null; email: string | null;
      secondary_email: string | null; phone: string | null; role: string | null;
      expiry_date: string | null; disabled: boolean; github_username: string | null;
      slack_username: string | null; ldap_groups: string[];
    }>(`SELECT first_name, last_name, email, secondary_email, phone, role,
               expiry_date, disabled, github_username, slack_username, ldap_groups
        FROM users WHERE username = $1`, [context.user.username]),
    context.user.isLocalAdmin ? Promise.resolve(null) : ldap.getUser(context.user.username).catch(() => null),
  ]);
  const profile = rows[0];
  if (!profile) return null;
  return {
    firstName: profile.first_name, lastName: profile.last_name, email: profile.email,
    secondaryEmail: profile.secondary_email, phone: profile.phone, role: profile.role,
    expiryDate: profile.expiry_date, disabled: profile.disabled,
    githubUsername: profile.github_username, slackUsername: profile.slack_username,
    ldapGroups: profile.ldap_groups ?? [], sshPublicKeys: ldapUser?.sshPublicKeys ?? [],
  };
}

export async function updateAccountProfile(
  context: RosterUiContext,
  fields: { secondaryEmail: string; phone: string; sshKeys: string },
): Promise<void> {
  const sshPublicKeys = fields.sshKeys.split('\n').map((key) => key.trim()).filter(Boolean);
  if (!context.user.isLocalAdmin) {
    const result = await ldap.setSshKeys(context.user.username, sshPublicKeys);
    if (result.status === 'failed') throw data(result.message, { status: 400 });
  }
  await db.query(
    'UPDATE users SET secondary_email = $1, phone = $2, updated_at = NOW() WHERE username = $3',
    [fields.secondaryEmail.trim().toLowerCase() || null, fields.phone.trim() || null, context.user.username],
  );
}
