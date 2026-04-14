import 'dotenv/config';
import express from 'express';
import { createNodeMiddleware } from '@octokit/webhooks';
import { getWebhooks } from './github.js';
import { registerWebhookHandlers } from './webhooks.js';
import { syncGithub, ensureOrgMember } from './sync.js';

const PORT = process.env.GITHUB_APP_PORT ?? '3001';
const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function runSync() {
  try {
    await syncGithub();
  } catch (err) {
    console.error('[github-sync] sync failed:', err);
  }
}

async function bootstrap() {
  registerWebhookHandlers();

  const app = express();

  app.use('/webhook', createNodeMiddleware(getWebhooks(), { path: '/webhook' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Internal endpoint — called by the backend when a github_username is saved
  app.post('/invite', express.json(), async (req, res) => {
    const { githubUsername } = req.body as { githubUsername?: string };
    if (!githubUsername) {
      res.status(400).json({ ok: false, message: 'githubUsername required' });
      return;
    }
    const result = await ensureOrgMember(githubUsername);
    res.json({ ok: true, result });
  });

  app.listen(parseInt(PORT as string, 10), () => {
    console.log(`E4E GitHub App listening on port ${PORT}`);
  });

  await runSync();
  setInterval(runSync, SYNC_INTERVAL_MS);
}

bootstrap().catch((err) => {
  console.error('Failed to start GitHub App:', err);
  process.exit(1);
});
