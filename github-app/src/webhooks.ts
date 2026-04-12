/**
 * GitHub webhook event handlers.
 *
 * Keeps the roster DB in sync when org membership changes happen directly
 * in GitHub (manual invites, removals) rather than through this platform.
 */
import { getWebhooks } from './github';
import { db } from './db';

export function registerWebhookHandlers(): void {
  const webhooks = getWebhooks();

  // Member added to the org
  webhooks.on('organization.member_added', async ({ payload }) => {
    const login = payload.membership.user.login;
    console.log(`[webhook] member added to org: ${login}`);
    await db.query(
      `UPDATE users SET github_username = $1, updated_at = NOW()
       WHERE github_username = $1`,
      [login],
    );
    // If not in roster yet, log for review — don't auto-create
    const { rows } = await db.query('SELECT id FROM users WHERE github_username = $1', [login]);
    if (!rows.length) {
      console.warn(`[webhook] ${login} joined GitHub org but has no roster entry — review manually`);
    }
  });

  // Member removed from the org
  webhooks.on('organization.member_removed', async ({ payload }) => {
    const login = payload.membership.user.login;
    console.log(`[webhook] member removed from org: ${login}`);
    // Just log — don't auto-delete from roster, admin should review
    const { rows } = await db.query('SELECT username FROM users WHERE github_username = $1', [login]);
    if (rows.length) {
      console.warn(`[webhook] ${login} removed from GitHub org — roster entry: ${rows[0].username}`);
    }
  });

  webhooks.onError((error) => {
    console.error('[webhook] error:', error);
  });
}
