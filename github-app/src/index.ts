import 'dotenv/config';
import express from 'express';
import { createNodeMiddleware } from '@octokit/webhooks';
import { getWebhooks } from './github';
import { registerWebhookHandlers } from './webhooks';

const PORT = process.env.GITHUB_APP_PORT ?? '3001';

async function bootstrap() {
  registerWebhookHandlers();

  const app = express();

  // Webhook endpoint — signature verified by @octokit/webhooks middleware
  app.use('/webhook', createNodeMiddleware(getWebhooks(), { path: '/webhook' }));

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.listen(parseInt(PORT as string, 10), () => {
    console.log(`E4E GitHub App listening on port ${PORT}`);
  });
}

bootstrap().catch((err) => {
  console.error('Failed to start GitHub App:', err);
  process.exit(1);
});
