import 'dotenv/config';
import { Issuer } from 'openid-client';
import { setupPassport } from './auth';
import { createApp } from './app';
import { runMigrations } from './services/db';
import { startSyncSchedule } from './services/sync';
import { ensureExtendedAttributes } from './services/udm';

async function bootstrap(): Promise<void> {
  const {
    OIDC_ISSUER_URL,
    OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET,
    OIDC_REDIRECT_URI,
    SESSION_SECRET,
    PORT = '3000',
  } = process.env;

  if (!OIDC_ISSUER_URL || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET || !OIDC_REDIRECT_URI) {
    throw new Error(
      'Missing required OIDC env vars: OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_REDIRECT_URI',
    );
  }
  if (!SESSION_SECRET) {
    throw new Error('SESSION_SECRET env var is required');
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

  await runMigrations();
  // Ensure custom LDAP extended attributes exist before first sync
  await ensureExtendedAttributes().catch((err) =>
    console.warn('[startup] ensureExtendedAttributes failed (non-fatal):', err),
  );
  startSyncSchedule();

  const app = createApp();
  app.listen(parseInt(PORT, 10), () => {
    // TODO: replace localhost with actual configured URL (e.g. from a BASE_URL env var)
    console.log(`E4E Roster running at http://localhost:${PORT}`);
  });
}

bootstrap().catch((err: unknown) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
