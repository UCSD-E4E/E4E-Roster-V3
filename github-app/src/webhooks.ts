/**
 * GitHub webhook event handlers.
 *
 * Keeps the roster DB in sync when org membership changes happen directly
 * in GitHub (manual invites, removals) rather than through this platform.
 */
import type { EmitterWebhookEvent } from '@octokit/webhooks';
import { getWebhooks } from './github.js';
import { db } from './db.js';

export function registerWebhookHandlers(): void {
  const webhooks = getWebhooks();

  // Member added to the org
  webhooks.on('organization.member_added', async ({ payload }: EmitterWebhookEvent<'organization.member_added'>) => {
    const login = payload.membership.user?.login;
    if (!login) return;
    console.log(`[webhook] member added to org: ${login}`);
    // If not in roster yet, log for review — don't auto-create
    const { rows } = await db.query('SELECT id FROM users WHERE github_username = $1', [login]);
    if (!rows.length) {
      console.warn(`[webhook] ${login} joined GitHub org but has no roster entry — review manually`);
    }
  });

  // Member removed from the org
  webhooks.on('organization.member_removed', async ({ payload }: EmitterWebhookEvent<'organization.member_removed'>) => {
    const login = payload.membership.user?.login;
    if (!login) return;
    console.log(`[webhook] member removed from org: ${login}`);
    const { rows } = await db.query('SELECT username FROM users WHERE github_username = $1', [login]);
    if (rows.length) {
      console.warn(`[webhook] ${login} removed from GitHub org — roster entry: ${(rows[0] as { username: string }).username}`);
    }
  });

  webhooks.onError((error: Error) => {
    console.error('[webhook] error:', error);
  });
}
