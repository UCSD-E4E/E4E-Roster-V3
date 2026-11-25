import React from 'react';
import { Router } from 'express';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthentikError, createCollaboratorInvite, getCollaboratorCatalog, type CollaboratorCatalog, type CollaboratorInvite } from '../services/authentik';
import { isCollabAdmin } from '../services/collab-access';
import { db } from '../services/db';
import { requireSameOriginMutation, setReactWorkspaceHeaders } from './security';

function CollabPage({ catalog, result, error }: { catalog?: CollaboratorCatalog; result?: CollaboratorInvite; error?: string }): React.JSX.Element {
  return <html lang="en" data-theme="dark"><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Collaborator invitations — Roster</title><link rel="stylesheet" href="/static/css/react-roster.css" /><script src="/static/js/react-roster-theme.js" defer />
  </head><body><div className="workspace-shell"><header className="workspace-header"><a className="brand-mark" href="/collab-manage">Roster collaborators</a><nav aria-label="Collaborator navigation"><a href="/orgs">My organizations</a></nav><button className="theme-toggle" id="theme-toggle" type="button">Light mode</button></header>
    <main className="workspace-main"><section className="hero-row"><div><p className="eyebrow">External access</p><h1>Invite a collaborator</h1><p className="lede">Create a single-use invitation for a partner’s web applications. The recipient chooses their account details and verifies their email.</p></div></section>
      {error && <p className="form-error" role="alert">{error}</p>}
      {error && !catalog && <p><a href="/collab-manage">Return to invitations</a></p>}
      {result ? <section className="content-card"><h2>Invitation ready</h2><p>Send this link to <strong>{result.email}</strong>. It expires at {result.expires}.</p><p>{result.tenant} · {result.org}</p><label>Invitation link<input aria-label="Invitation link" readOnly value={result.url} /></label><p><a href={result.url} rel="noreferrer">Open enrollment</a></p><h2>Application links</h2><p>After enrollment, the collaborator can open these applications directly.</p><ul>{result.applications.map((app) => <li key={app.url}><a href={app.url} rel="noreferrer">{app.name}</a></li>)}</ul><p>The email confirmation link sent during enrollment expires after 30 minutes.</p><a className="button primary" href="/collab-manage">Create another invitation</a></section> : catalog && <section className="form-card"><form method="post" className="workspace-form">
        <label>Invitee email<input type="email" name="email" required maxLength={254} autoComplete="email" /></label>
        <fieldset className="form-section"><legend>Tenant and partner organization</legend><p>Select one partner organization. Choices are fetched from Authentik.</p>{catalog.tenants.length ? catalog.tenants.map((tenant) => <fieldset key={tenant.id}><legend>{tenant.name}</legend>{tenant.organizations.map((org) => <label key={org.id}><input type="radio" name="destination" required value={`${tenant.id}/${org.id}`} /> {org.name}</label>)}<p>Applications: {tenant.applications.map((app) => app.name).join(', ')}</p></fieldset>) : <p>No collaborator organizations are configured in Authentik.</p>}</fieldset>
        <label>Invitation expires in<select name="days" defaultValue="7"><option value="1">1 day</option><option value="3">3 days</option><option value="7">7 days</option><option value="14">14 days</option><option value="30">30 days</option></select></label><p className="form-copy">Only the invited email address can enroll. The invitation creates web-only access and does not create a Samba account or a roster entry.</p><button className="button primary" type="submit" disabled={!catalog.tenants.length}>Create invitation</button>
      </form></section>}
    </main></div></body></html>;
}

export function createCollabRouter(): Router {
  const router = Router();
  router.use(setReactWorkspaceHeaders, requireSameOriginMutation);
  router.use(async (req, res, next) => {
    try {
      if (!req.isAuthenticated() || !req.user || !await isCollabAdmin(req.user)) {
        res.status(403).type('text').send('Access denied: collab-admins role required.'); return;
      }
      next();
    } catch (error) { next(error); }
  });
  router.get('/', async (req, res, next) => {
    try {
      const result = req.session.collaboratorInvite;
      delete req.session.collaboratorInvite;
      const catalog = result ? undefined : await getCollaboratorCatalog();
      res.type('html').send(`<!DOCTYPE html>${renderToStaticMarkup(<CollabPage catalog={catalog} result={result} />)}`);
    } catch (error) {
      if (!(error instanceof AuthentikError)) return next(error);
      res.status(error.status).type('html').send(`<!DOCTYPE html>${renderToStaticMarkup(<CollabPage error={error.message} />)}`);
    }
  });
  router.post('/', async (req, res, next) => {
    try {
      const destination = typeof req.body.destination === 'string' ? req.body.destination.split('/') : [];
      if (destination.length !== 2 || typeof req.body.email !== 'string' || typeof req.body.days !== 'string') throw new AuthentikError('Choose a destination, email address, and invitation lifetime.', 400);
      // Record the attempt before calling the provider. The returned bearer link
      // is never written to audit details, request URLs, or application logs.
      await db.query("INSERT INTO audit_log (actor, action, details) VALUES ($1, 'collaborator_invite_requested', $2)", [req.user!.username, JSON.stringify({ tenant: destination[0], org: destination[1], email: req.body.email })]);
      req.session.collaboratorInvite = await createCollaboratorInvite({ tenant: destination[0], org: destination[1], email: req.body.email, days: req.body.days });
      res.redirect(303, '/collab-manage');
    } catch (error) {
      if (!(error instanceof AuthentikError)) return next(error);
      // Do not retry or recreate on an ambiguous upstream timeout. Reloading
      // shows current choices; an administrator can check provider-side events.
      res.status(error.status).type('html').send(`<!DOCTYPE html>${renderToStaticMarkup(<CollabPage error={error.message} />)}`);
    }
  });
  return router;
}
