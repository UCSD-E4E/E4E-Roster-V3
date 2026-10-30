import { Router } from 'express';
import { renderToStaticMarkup } from 'react-dom/server';
import { completeSlackOnboarding, onboardingDetails, onboardingTokenHash } from '../integrations/onboarding';
import { SlackConnectPage } from '../ui/slack-connect';
import { requireSameOriginMutation, setReactWorkspaceHeaders } from '../ui/security';

export function slackConnectRouter(): Router {
  const router = Router();
  router.use(setReactWorkspaceHeaders, (_req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer'); next();
  });
  // Slack link scanners and GET requests never claim the invitation.
  router.get('/:token', async (req, res) => {
    const raw = req.params.token;
    if (!/^[a-f0-9]{64}$/.test(raw)) { res.status(400).send('Invalid connection link.'); return; }
    const hash = onboardingTokenHash(raw);
    try {
      await onboardingDetails(hash);
      req.session.slackOnboardingHash = hash;
      req.session.save(() => res.redirect('/connect/slack'));
    } catch {
      res.status(400).type('html').send('<!doctype html>'+renderToStaticMarkup(<SlackConnectPage error="This connection link is unavailable or expired." />));
    }
  });
  router.get('/', async (req, res) => {
    try {
      if (!req.session.slackOnboardingHash) throw new Error('Open your personal connection link from Slack.');
      const details = await onboardingDetails(req.session.slackOnboardingHash);
      res.type('html').send('<!doctype html>'+renderToStaticMarkup(<SlackConnectPage organization={details.name} username={req.isAuthenticated() ? req.user?.username : undefined} />));
    } catch {
      res.status(400).type('html').send('<!doctype html>'+renderToStaticMarkup(<SlackConnectPage error="Open a fresh connection link from Slack. The previous link may be expired or unavailable." />));
    }
  });
  router.post('/', requireSameOriginMutation, async (req, res, next) => {
    if (!req.isAuthenticated() || !req.user) { res.redirect('/connect/slack'); return; }
    if (!req.session.slackOnboardingHash) { res.status(400).send('Open your personal connection link from Slack.'); return; }
    try {
      const result = await completeSlackOnboarding(req.session.slackOnboardingHash, req.user, String(req.body.githubUsername ?? '').trim());
      if (result.confirmationRequired) {
        res.type('html').send('<!doctype html>'+renderToStaticMarkup(<SlackConnectPage organization={result.organization}
          username={req.user.username} githubUsername={String(req.body.githubUsername ?? '').trim()}
          confirmationCode={result.confirmationCode} slackEmail={result.slackEmail} />));
        return;
      }
      delete req.session.slackOnboardingHash;
      // Persist the refreshed membership list through the existing Passport serializer.
      req.login(req.user, error => {
        if (error) return next(error);
        res.type('html').send('<!doctype html>'+renderToStaticMarkup(<SlackConnectPage completed organization={result.organization} accountPath={result.accountPath} />));
      });
    } catch (error) {
      // Application validation errors only; do not echo provider/database errors containing credentials or tokens.
      const message = error instanceof Error && /^(Use your|Enter a valid|Your |An active|A different|This connection)/.test(error.message) ? error.message : 'Connection failed. Please try again or contact your roster administrator.';
      res.status(400).type('html').send('<!doctype html>'+renderToStaticMarkup(<SlackConnectPage username={req.user.username} githubUsername={String(req.body.githubUsername ?? '')} error={message} />));
    }
  });
  return router;
}
