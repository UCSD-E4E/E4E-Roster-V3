import express, { Request, Response, NextFunction, Router } from 'express';
import session from 'express-session';
import passport from 'passport';
import nunjucks from 'nunjucks';
import helmet from 'helmet';
import path from 'path';

import { requireAuth } from './middleware/requireAuth';
import { requireSystemAdmin } from './middleware/requireSystemAdmin';
import { requireOrgMember } from './middleware/requireOrgMember';

import authRouter from './routes/auth';
import localAuthRouter from './routes/local-auth';
import orgsRouter from './routes/orgs';
import dashboardRouter from './routes/dashboard';
import accountRouter from './routes/account';
import adminRouter from './routes/admin/index';
import plRouter from './routes/pl/index';
import systemRouter from './routes/system/index';

export function createApp(): express.Application {
  const app = express();

  const viewsDir  = process.env.VIEWS_DIR  ?? path.join(__dirname, '../views');
  const staticDir = process.env.STATIC_DIR ?? path.join(__dirname, '../../frontend/static');

  nunjucks.configure(viewsDir, { autoescape: true, express: app });
  app.set('view engine', 'njk');

  // ── Security headers ─────────────────────────────────────────────
  // CSP is intentionally disabled until inline <script> blocks in templates
  // are moved to external files. All other helmet defaults are active:
  // X-Content-Type-Options, X-Frame-Options (SAMEORIGIN), HSTS, Referrer-Policy, etc.
  app.use(helmet({ contentSecurityPolicy: false }));

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/static', express.static(staticDir));

  if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

  app.use(
    session({
      secret: process.env.SESSION_SECRET!,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        // 'lax' (not 'strict') is required: the OIDC callback is a cross-site
        // redirect from Authentik — strict would break it. lax still blocks
        // cross-origin POST, so it provides meaningful CSRF defence.
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000,
      },
    }),
  );

  app.use(passport.initialize());
  app.use(passport.session());

  // Make authenticated user available in all templates
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.user = req.user ?? null;
    next();
  });

  // ── Public auth routes ────────────────────────────────────────────
  app.use('/', authRouter);
  app.use('/', localAuthRouter);

  // ── Root: redirect to primary org or org selector ─────────────────
  app.get('/', (req: Request, res: Response) => {
    if (!req.isAuthenticated() || !req.user) return res.redirect('/login');
    const { user } = req;
    if (user.isSystemAdmin || user.isLocalAdmin) {
      return user.orgs.length > 0
        ? res.redirect(`/orgs/${user.orgs[0].orgSlug}`)
        : res.redirect('/system');
    }
    if (user.orgs.length === 1) return res.redirect(`/orgs/${user.orgs[0].orgSlug}`);
    return res.redirect('/orgs');
  });

  // ── Org selector (multi-org users, or users with no memberships) ──
  app.use('/orgs', requireAuth, orgsRouter);

  // ── Org-scoped routes: /orgs/:orgSlug/* ──────────────────────────
  const orgRouter = Router({ mergeParams: true });

  orgRouter.use(requireAuth);
  orgRouter.use(requireOrgMember as express.RequestHandler);
  orgRouter.use((req: Request, res: Response, next: NextFunction) => {
    res.locals.orgBase              = `/orgs/${req.currentOrg!.slug}`;
    res.locals.currentOrg           = req.currentOrg;
    res.locals.currentOrgMembership = req.currentOrgMembership;
    res.locals.orgPrimary           = req.currentOrg!.theme_color;
    next();
  });

  orgRouter.get('/', (_req, res: Response) => res.redirect(res.locals.orgBase + '/dashboard'));
  orgRouter.use('/dashboard', dashboardRouter);
  orgRouter.use('/account',   accountRouter);
  orgRouter.use('/admin',     adminRouter);
  orgRouter.use('/pl',        plRouter);

  app.use('/orgs/:orgSlug', orgRouter);

  // ── System admin (cross-org) ──────────────────────────────────────
  app.use('/system', requireAuth, requireSystemAdmin, systemRouter);

  // ── Global error handler ──────────────────────────────────────────
  // Must be last: 4-argument signature tells Express this is an error handler.
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    console.error('[error]', req.method, req.path, err);
    if (res.headersSent) return;
    res.status(500).send('Internal server error');
  });

  return app;
}
