import 'dotenv/config';
import express from 'express';
import { createNodeMiddleware } from '@octokit/webhooks';
import { getWebhooks } from './github.js';
import { registerWebhookHandlers } from './webhooks.js';
import { syncGithub, ensureOrgMember } from './sync.js';
import { listTeams, addToTeam } from './github.js';

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
  app.use(express.json());

  app.use('/webhook', createNodeMiddleware(getWebhooks(), { path: '/webhook' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/teams', async (req, res) => {
    const orgId = req.query['orgId'] ? parseInt(req.query['orgId'] as string, 10) : undefined;
    try {
      const teams = await listTeams(orgId);
      res.json(teams);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/team-member', async (req, res) => {
    const { teamSlug, githubUsername, orgId: rawOrgId } = req.body as {
      teamSlug?: string;
      githubUsername?: string;
      orgId?: number;
    };
    if (!teamSlug || !githubUsername) {
      res.status(400).json({ error: 'teamSlug and githubUsername required' });
      return;
    }
    const orgId = rawOrgId !== undefined ? Number(rawOrgId) : undefined;
    try {
      await addToTeam(githubUsername, teamSlug, orgId);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Internal endpoint — called by the backend when a github_username is saved
  app.post('/invite', async (req, res) => {
    const { githubUsername, orgId: rawOrgId } = req.body as {
      githubUsername?: string;
      orgId?: number;
    };
    if (!githubUsername) {
      res.status(400).json({ ok: false, message: 'githubUsername required' });
      return;
    }
    const orgId = rawOrgId !== undefined ? Number(rawOrgId) : undefined;
    const result = await ensureOrgMember(githubUsername, orgId);
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
