import express from 'express';
import session from 'express-session';
import passport from 'passport';
import nunjucks from 'nunjucks';
import path from 'path';

import authRouter from './routes/auth';
import dashboardRouter from './routes/dashboard';
import accountRouter from './routes/account';
import adminRouter from './routes/admin/index';
import plRouter from './routes/pl/index';
import systemRouter from './routes/system/index';
import orgsRouter from './routes/orgs/index';
import debugRouter from './routes/admin/debug'; // TEMPORARY — see /DEBUG_CHANGES.md

export function createApp(): express.Application {
  const app = express();

  // Resolve template and static asset directories.
  // VIEWS_DIR / STATIC_DIR env vars are set in Docker; defaults work for local dev.
  const viewsDir =
    process.env.VIEWS_DIR ?? path.join(__dirname, '../views');
  const staticDir =
    process.env.STATIC_DIR ?? path.join(__dirname, '../../frontend/static');

  nunjucks.configure(viewsDir, { autoescape: true, express: app });
  app.set('view engine', 'njk');

  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/static', express.static(staticDir));

  app.use(
    session({
      secret: process.env.SESSION_SECRET!,
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 8 * 60 * 60 * 1000, // 8 hours
      },
    }),
  );

  app.use(passport.initialize());
  app.use(passport.session());

  app.get('/', (req, res) => {
    res.redirect(req.isAuthenticated() ? '/dashboard' : '/login');
  });

  app.use('/', authRouter);
  app.use('/dashboard', dashboardRouter);
  app.use('/account', accountRouter);
  app.use('/admin', adminRouter);
  app.use('/system', systemRouter);
  app.use('/debug', debugRouter); // TEMPORARY — see /DEBUG_CHANGES.md
  app.use('/orgs/:orgSlug', orgsRouter);
  app.use('/pl', plRouter);

  return app;
}
