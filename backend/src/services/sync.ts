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

  // Build a lookup of what LDAP already has for the extended attributes
  const ldapByUsername = new Map(users.map((u) => [u.username, u]));

  for (const u of users) {
    try {
      await db.query(
        `INSERT INTO users
           (username, first_name, last_name, email, expiry_date, disabled, ldap_groups, ldap_dn,
            slack_username, github_username, role, last_synced_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
         ON CONFLICT (username) DO UPDATE SET
           first_name      = EXCLUDED.first_name,
           last_name       = EXCLUDED.last_name,
           email           = EXCLUDED.email,
           expiry_date     = COALESCE(users.expiry_date, EXCLUDED.expiry_date),
           disabled        = EXCLUDED.disabled,
           ldap_groups     = EXCLUDED.ldap_groups,
           ldap_dn         = EXCLUDED.ldap_dn,
           slack_username  = COALESCE(users.slack_username,  EXCLUDED.slack_username),
           github_username = COALESCE(users.github_username, EXCLUDED.github_username),
           role            = COALESCE(users.role,            EXCLUDED.role),
           last_synced_at  = NOW(),
           updated_at      = NOW()`,
        [
          u.username,
          u.firstName,
          u.lastName,
          u.email,
          u.expiryDate || null,
          u.disabled,
          u.groups,
          u.dn,
          u.slackId || null,
          u.githubUsername || null,
          u.role || null,
        ],
      );
      synced++;
    } catch (err) {
      console.error(`[sync] failed to upsert user ${u.username}:`, err);
      errors++;
    }
  }

  console.log(`[sync] done — ${synced} synced, ${errors} errors`);

  // ── Write-back pass: DB → LDAP for extended attributes ───────────
  // Any slack_username or github_username set in the DB that differs from
  // what's currently in LDAP gets written back via the extended attributes.
  await writeBackExtendedAttributes(ldapByUsername);

  return { synced, errors };
}

type DbRow = {
  username: string;
  slack_username: string | null;
  github_username: string | null;
  role: string | null;
  expiry_date: string | null;
};

async function writeBackExtendedAttributes(
  ldapByUsername: Map<string, udm.UdmUser>,
): Promise<void> {
  const { rows } = await db.query<DbRow>(
    `SELECT username, slack_username, github_username, role,
            TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date
     FROM users
     WHERE slack_username IS NOT NULL OR github_username IS NOT NULL
        OR role IS NOT NULL OR expiry_date IS NOT NULL`,
  );

  let written = 0;
  for (const row of rows) {
    const ldap = ldapByUsername.get(row.username);
    const needsSlack  = row.slack_username  && row.slack_username  !== ldap?.slackId;
    const needsGithub = row.github_username && row.github_username !== ldap?.githubUsername;
    const needsRole   = row.role            && row.role            !== ldap?.role;
    const needsExpiry = row.expiry_date     && row.expiry_date     !== ldap?.expiryDate;

    if (!needsSlack && !needsGithub && !needsRole && !needsExpiry) continue;

    const fields: { slackId?: string; githubUsername?: string; role?: string } = {};
    if (needsSlack)  fields.slackId        = row.slack_username!;
    if (needsGithub) fields.githubUsername = row.github_username!;
    if (needsRole)   fields.role           = row.role!;

    const promises: Promise<unknown>[] = [];

    if (Object.keys(fields).length > 0) {
      promises.push(
        udm.updateUserLdapFields(row.username, fields).then((r) => {
          if (r.status === 'success') {
            console.log(`[sync] wrote back extended attributes for ${row.username}`, fields);
          } else {
            console.warn(`[sync] extended attr write-back failed for ${row.username}: ${r.message}`);
          }
        }).catch((err) => console.warn(`[sync] extended attr write-back error for ${row.username}:`, err)),
      );
    }

    if (needsExpiry) {
      promises.push(
        udm.updateUserExpiry(row.username, row.expiry_date!).then((r) => {
          if (r.status === 'success') {
            console.log(`[sync] wrote back expiry for ${row.username}: ${row.expiry_date}`);
          } else {
            console.warn(`[sync] expiry write-back failed for ${row.username}: ${r.message}`);
          }
        }).catch((err) => console.warn(`[sync] expiry write-back error for ${row.username}:`, err)),
      );
    }

    await Promise.allSettled(promises);
    written++;
  }

  if (written > 0) console.log(`[sync] write-back done — ${written} user(s) updated in LDAP`);
}

export function startSyncSchedule(): void {
  // Run once on startup, then on interval
  syncUsers().catch((err) => console.error('[sync] initial sync failed:', err));
  setInterval(() => {
    syncUsers().catch((err) => console.error('[sync] scheduled sync failed:', err));
  }, SYNC_INTERVAL_MS);
}
