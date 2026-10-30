import { open } from 'node:fs/promises';

/** Queue downstream directory reconciliation without exposing directory data.
 * The deployment owns the signal path and its consumer (e.g. Authentik).
 */
export async function notifyLdapChange(): Promise<void> {
  const path = process.env.LDAP_CHANGE_SIGNAL_PATH;
  if (!path) return;
  try {
    // Exclusive creation coalesces pending changes, and never follows an existing
    // symlink or rewrites the consumer's in-progress request.
    const signal = await open(path, 'wx', 0o600);
    await signal.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
    // LDAP has already committed. A downstream failure must not turn a successful
    // directory edit into an apparent failure or expose paths/credentials.
    console.error('[ldap-change] Could not queue downstream sync; check the signal mount. Scheduled sync remains the fallback.');
  }
}
