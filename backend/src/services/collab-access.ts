import type { AuthUser } from '../types/user';
import { db } from './db';

export async function isCollabAdmin(user: AuthUser): Promise<boolean> {
  // Deliberately no system-admin bypass. Read every request so revocation does
  // not wait for the eight-hour SSO session to expire.
  const { rowCount } = await db.query(
    "SELECT 1 FROM roster_role_grants WHERE username = $1 AND role = 'collab-admins'", [user.username],
  );
  return !!rowCount;
}

export async function setCollabAdmin(actor: AuthUser, username: string, grant: boolean): Promise<void> {
  if (!actor.isSystemAdmin && !actor.isLocalAdmin) throw new Error('System administrator required.');
  if (!username || username.length > 100) throw new Error('A valid username is required.');
  // Allow system administrators to grant themselves access even before LDAP sync
  // has created their roster row. Other recipients must be known roster users.
  if (username !== actor.username) {
    const { rowCount } = await db.query('SELECT 1 FROM users WHERE username = $1 AND NOT disabled', [username]);
    if (!rowCount) throw new Error('Active roster user not found.');
  }
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (grant) await client.query("INSERT INTO roster_role_grants (username, role, granted_by) VALUES ($1, 'collab-admins', $2) ON CONFLICT DO NOTHING", [username, actor.username]);
    else await client.query("DELETE FROM roster_role_grants WHERE username = $1 AND role = 'collab-admins'", [username]);
    await client.query("INSERT INTO audit_log (actor, action, target_username) VALUES ($1, $2, $3)", [actor.username, grant ? 'grant_collab_admin' : 'revoke_collab_admin', username]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
