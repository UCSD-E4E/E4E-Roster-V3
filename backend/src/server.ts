import 'dotenv/config';
import { Issuer } from 'openid-client';
import bcrypt from 'bcryptjs';
import { setupPassport, setupPassportSession } from './auth';
import { createApp } from './app';
import { db, runMigrations } from './services/db';
import { startSyncSchedule } from './services/sync';
import { startIntegrationRuntime } from './integrations/runtime';

// Creates or updates the break-glass local admin from env vars on every startup.
// Remove BOOTSTRAP_ADMIN_USERNAME / BOOTSTRAP_ADMIN_PASSWORD from the environment
// once a real system admin has logged in via SSO and can manage local_admins through the UI.
async function bootstrapLocalAdmin(): Promise<void> {
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME;
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) return;

  const hash = await bcrypt.hash(password, 12);
  await db.query(
    `INSERT INTO local_admins (username, password_hash, enabled)
     VALUES ($1, $2, TRUE)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, enabled = TRUE, updated_at = NOW()`,
    [username, hash],
  );
  console.log(`[bootstrap] Local admin '${username}' ready. Remove BOOTSTRAP_ADMIN_* env vars after first SSO login.`);
}

async function bootstrap(): Promise<void> {
  const {
    OIDC_ISSUER_URL,
    OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET,
    OIDC_REDIRECT_URI,
    SESSION_SECRET,
    PORT = '3000',
    SKIP_OIDC,
  } = process.env;

  if (!SESSION_SECRET) {
    throw new Error('SESSION_SECRET env var is required');
  }
  if (SKIP_OIDC === 'true' && process.env.NODE_ENV === 'production') {
    throw new Error('SKIP_OIDC is not allowed in production.');
  }

  // The break-glass local-login route still needs Passport session support
  // when OIDC discovery is skipped for a disposable local environment.
  setupPassportSession();

  // Explicit local testing can run without Authentik; production cannot skip OIDC.
  if (SKIP_OIDC === 'true') {
    console.warn('[startup] SKIP_OIDC=true — OIDC auth disabled, localhost debug routes only');
  } else {
    if (!OIDC_ISSUER_URL || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET || !OIDC_REDIRECT_URI) {
      throw new Error(
        'Missing required OIDC env vars: OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI',
      );
    }

    console.log(`Discovering OIDC issuer at ${OIDC_ISSUER_URL}...`);
    const issuer = await Issuer.discover(OIDC_ISSUER_URL);
    console.log(`Issuer discovered: ${issuer.issuer}`);

    const client = new issuer.Client({
      client_id: OIDC_CLIENT_ID,
      client_secret: OIDC_CLIENT_SECRET,
      redirect_uris: [OIDC_REDIRECT_URI],
      response_types: ['code'],
    });

    setupPassport(client);
  }

  await runMigrations();
  await bootstrapLocalAdmin();
  startSyncSchedule();
  const stopIntegrations = startIntegrationRuntime();

  const app = createApp();
  const server = app.listen(parseInt(PORT, 10), () => {
    // TODO: replace localhost with actual configured URL (e.g. from a BASE_URL env var)
    console.log(`E4E Roster running at http://localhost:${PORT}`);
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
    void stopIntegrations().finally(() => server.close(() => process.exit(0)));
  });
}

bootstrap().catch((err: unknown) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
