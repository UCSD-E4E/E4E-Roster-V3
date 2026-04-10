import { db } from './db';
import * as udm from './udm';

const SYNC_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

export async function syncUsers(): Promise<{ synced: number; errors: number }> {
  console.log('[sync] starting UDM → DB user sync');
  let synced = 0;
  let errors = 0;

  let users: udm.UdmUser[];
  try {
    users = await udm.listUsers();
  } catch (err) {
    console.error('[sync] failed to fetch users from UDM:', err);
    throw err;
  }

  for (const u of users) {
    try {
      await db.query(
        `INSERT INTO users
           (username, first_name, last_name, email, expiry_date, disabled, ldap_groups, ldap_dn, last_synced_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
         ON CONFLICT (username) DO UPDATE SET
           first_name     = EXCLUDED.first_name,
           last_name      = EXCLUDED.last_name,
           email          = EXCLUDED.email,
           expiry_date    = EXCLUDED.expiry_date,
           disabled       = EXCLUDED.disabled,
           ldap_groups    = EXCLUDED.ldap_groups,
           ldap_dn        = EXCLUDED.ldap_dn,
           last_synced_at = NOW(),
           updated_at     = NOW()`,
        [
          u.username,
          u.firstName,
          u.lastName,
          u.email,
          u.expiryDate || null,
          u.disabled,
          u.groups,
          u.dn,
        ],
      );
      synced++;
    } catch (err) {
      console.error(`[sync] failed to upsert user ${u.username}:`, err);
      errors++;
    }
  }

  console.log(`[sync] done — ${synced} synced, ${errors} errors`);
  return { synced, errors };
}

export function startSyncSchedule(): void {
  // Run once on startup, then on interval
  syncUsers().catch((err) => console.error('[sync] initial sync failed:', err));
  setInterval(() => {
    syncUsers().catch((err) => console.error('[sync] scheduled sync failed:', err));
  }, SYNC_INTERVAL_MS);
}
