import 'dotenv/config';
import http from 'http';
import { createDecipheriv } from 'crypto';
import { App } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import type { WebClient as WebClientType } from '@slack/web-api';
import { db } from './db';
import { syncSlack } from './sync';
import { sendPostSyncNotifications } from './notify';
import { registerCheckCommand } from './commands/check';
import { registerExtendCommand } from './commands/extend';

const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function bootstrap() {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  registerCheckCommand(app);
  registerExtendCommand(app);

  await app.start();
  console.log('E4E Slack bot running (socket mode)');
  startInternalServer(app.client);

  await runSync(app);
  setInterval(() => runSync(app), SYNC_INTERVAL_MS);
}

async function runSync(app: App) {
  try {
    const report = await syncSlack(app.client);

    if (report.inSlackNotRoster.length > 0) {
      console.warn(`[slack-sync] ${report.inSlackNotRoster.length} Slack member(s) not in roster`);
    }
    if (report.inRosterNotSlack.length > 0) {
      console.warn(`[slack-sync] ${report.inRosterNotSlack.length} roster user(s) not found in Slack`);
    }

    await sendPostSyncNotifications(app.client, report);
  } catch (err) {
    console.error('[slack-sync] sync failed:', err);
  }
}

bootstrap().catch((err) => {
  console.error('Failed to start Slack bot:', err);
  process.exit(1);
});

// ── Per-org WebClient lookup ──────────────────────────────────────────────────

// AES-256-GCM decrypt — must stay in sync with backend/src/services/crypto.ts (decrypt).
// Duplicated here because the slackbot is a separate Docker service with its own package.
function decryptField(ciphertext: string): string {
  const hexKey = process.env.ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) throw new Error('ENCRYPTION_KEY not set');
  const key  = Buffer.from(hexKey, 'hex');
  const data = Buffer.from(ciphertext, 'base64');
  const iv   = data.subarray(0, 12);
  const tag  = data.subarray(12, 28);
  const enc  = data.subarray(28);
  const dc   = createDecipheriv('aes-256-gcm', key, iv);
  dc.setAuthTag(tag);
  return Buffer.concat([dc.update(enc), dc.final()]).toString('utf8');
}

/**
 * Returns a WebClient scoped to the given org's bot token.
 * Falls back to the global SLACK_BOT_TOKEN env var if no orgId is supplied.
 */
async function getClientForOrg(defaultClient: WebClientType, orgId?: number): Promise<WebClientType | null> {
  if (orgId === undefined) return defaultClient;

  const { rows } = await db.query<{ config: Record<string, string>; enabled: boolean }>(
    'SELECT config, enabled FROM org_integrations WHERE org_id = $1 AND service = $2',
    [orgId, 'slack'],
  );
  const row = rows[0];
  if (!row?.enabled || !row.config.botToken) {
    console.warn(`[slackbot] No enabled Slack credentials for org ${orgId}`);
    return null;
  }
  try {
    const token = decryptField(row.config.botToken);
    return new WebClient(token);
  } catch (err) {
    console.warn(`[slackbot] Failed to decrypt credentials for org ${orgId}:`, err);
    return null;
  }
}

// ── Internal HTTP server (service-to-service only, never public) ──

function startInternalServer(defaultClient: WebClientType): void {
  const port = parseInt(process.env.SLACK_INTERNAL_PORT ?? '3002', 10);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/channels') {
      const orgId = url.searchParams.get('orgId') ? parseInt(url.searchParams.get('orgId')!, 10) : undefined;
      const client = await getClientForOrg(defaultClient, orgId);
      if (!client) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Slack not configured for this org' }));
        return;
      }
      try {
        const result = await client.conversations.list({
          types: 'public_channel',
          exclude_archived: true,
          limit: 1000,
        });
        const channels = (result.channels ?? []).map((c) => ({ id: c.id, name: c.name }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(channels));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/invite') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        try {
          const { channelId, slackUserId, orgId: rawOrgId } = JSON.parse(body) as {
            channelId?: string;
            slackUserId?: string;
            orgId?: number;
          };
          if (!channelId || !slackUserId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'channelId and slackUserId required' }));
            return;
          }
          const orgId = rawOrgId !== undefined ? Number(rawOrgId) : undefined;
          const client = await getClientForOrg(defaultClient, orgId);
          if (!client) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Slack not configured for this org' }));
            return;
          }
          // Ensure the bot is in the channel before inviting (public channels only)
          try {
            await client.conversations.join({ channel: channelId });
          } catch {
            // Private channels can't be joined this way — bot must be added manually
          }
          await client.conversations.invite({ channel: channelId, users: slackUserId });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err: unknown) {
          const code = (err as { data?: { error?: string } })?.data?.error;
          if (code === 'already_in_channel') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, already_in_channel: true }));
          } else {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: String(err) }));
          }
        }
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => console.log(`[slackbot] internal API listening on port ${port}`));
}
