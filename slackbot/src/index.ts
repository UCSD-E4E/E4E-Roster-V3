import 'dotenv/config';
import http from 'http';
import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
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

// ── Internal HTTP server (service-to-service only, never public) ──

function startInternalServer(client: WebClient): void {
  const port = parseInt(process.env.SLACK_INTERNAL_PORT ?? '3002', 10);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/channels') {
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
          const { channelId, slackUserId } = JSON.parse(body) as { channelId?: string; slackUserId?: string };
          if (!channelId || !slackUserId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'channelId and slackUserId required' }));
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
