import { Router, raw } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { connectionFor, secret, resolveConnection } from './config';
import { auditIntegration } from '../services/integrations';

export function githubWebhookRouter(): Router {
  const router = Router();
  router.post('/:orgId', raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    try {
      const connection = await connectionFor(Number(req.params.orgId), 'github');
      if (!Buffer.isBuffer(req.body)) { res.status(400).json({ error: 'JSON payload required.' }); return; }
      const signature = req.header('x-hub-signature-256') ?? '';
      const expected = `sha256=${createHmac('sha256', secret(connection, 'webhookSecret')).update(req.body).digest('hex')}`;
      if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        res.status(401).json({ error: 'Invalid signature.' }); return;
      }
      const payload = JSON.parse(req.body.toString('utf8')) as { installation?: { id: number }; organization?: { login: string }; zen?: string };
      const event = req.header('x-github-event');
      // A signed ping may precede installation. Other events must match both tenant and installation.
      if (event !== 'ping') {
        const resolved = await resolveConnection('github', 'installationId', String(payload.installation?.id), connection.config.appId);
        if (resolved.orgId !== connection.orgId || payload.organization?.login.toLowerCase() !== connection.config.org.toLowerCase()) {
          res.status(403).json({ error: 'Installation does not match this organization.' }); return;
        }
      }
      // Prototype observes membership events; it does not grant/revoke access in response to webhooks.
      await auditIntegration(connection.orgId, 'github-webhook', 'github_webhook_received', null,
        { event, deliveryId: req.header('x-github-delivery'), installationId: payload.installation?.id });
      res.status(202).json({ ok: true, mode: 'observe-only' });
    } catch { res.status(400).json({ error: 'Webhook could not be verified for this organization.' }); }
  });
  return router;
}
