import { App } from '@slack/bolt';
import { db } from '../services/db';
import { Connection, secret, resolveConnection } from './config';
import { handleSlackCommand } from './slack-actions';
import { runIntegrationSync } from '../services/integrations';
import { integrationAdapters } from './providers';
import { runDueSlackOnboarding, userRequestedOnboarding } from './onboarding';

// One outbound socket per configured app/workspace. It lives in the existing backend process.
// Checking configuration periodically makes enable/disable and credential rotation effective without restart.
export function startIntegrationRuntime(): () => Promise<void> {
  const sockets = new Map<number, { app: App; revision: string }>();
  let refreshing = false; let stopping = false;
  async function refresh() {
    if (refreshing || stopping) return;
    refreshing = true;
    try {
      const { rows } = await db.query<{ org_id: number; config: Record<string, string>; revision: string }>(
        `SELECT org_id, config, updated_at::text AS revision FROM org_integrations WHERE service='slack' AND enabled`);
      for (const [id, socket] of sockets) {
        if (!rows.some(row => row.org_id === id && row.revision === socket.revision)) { await socket.app.stop(); sockets.delete(id); }
      }
      for (const row of rows) {
        if (stopping) break;
        if (sockets.has(row.org_id) || !row.config.appToken) continue;
        let startingApp: App | undefined;
        try {
          const connection: Connection = { orgId: row.org_id, service: 'slack', config: row.config, revision: row.revision };
          await integrationAdapters().slack(connection).verify();
          const app = new App({ socketMode: true, appToken: secret(connection, 'appToken'),
            authorize: async ({ teamId }) => {
              if (!teamId) throw new Error('Missing Slack workspace.');
              const current = await resolveConnection('slack', 'teamId', teamId);
              if (current.orgId !== row.org_id) throw new Error('Unexpected Slack workspace.');
              return { botToken: secret(current, 'botToken') };
            } });
          startingApp = app;
          for (const command of ['/roster-check', '/roster-extend', '/roster-connect']) app.command(command, async ({ command: payload, ack, respond }) => {
            await ack();
            try {
              const current = await resolveConnection('slack', 'teamId', payload.team_id);
              const text = command === '/roster-connect' ? await userRequestedOnboarding(current.orgId, payload.user_id) : await handleSlackCommand(payload.team_id, payload.user_id, command);
              await respond({ response_type: 'ephemeral', text });
            }
            catch (error) { await respond({ response_type: 'ephemeral', text: error instanceof Error ? error.message : 'Roster operation failed.' }); }
          });
          app.error(async () => { console.error(`[integrations] Slack handler failed for organization ${row.org_id}`); });
          await app.start();
          if (stopping) { await app.stop(); break; }
          sockets.set(row.org_id, { app, revision: row.revision });
          console.log(`[integrations] Slack connected for organization ${row.org_id}`);
        } catch {
          if (startingApp) await startingApp.stop().catch(() => {});
          console.warn(`[integrations] Slack connection failed for organization ${row.org_id}; check settings.`);
        }
      }
    } catch { console.warn('[integrations] Configuration refresh failed.'); }
    finally { refreshing = false; }
  }
  let syncing = false;
  async function sync() {
    if (syncing || stopping || process.env.INTEGRATION_AUTO_SYNC !== 'true') return;
    syncing = true;
    try {
      const { rows } = await db.query<{ org_id: number }>('SELECT DISTINCT org_id FROM org_integrations WHERE enabled');
      for (const row of rows) { try { await runIntegrationSync(row.org_id); } catch { console.warn(`[integrations] Sync failed for organization ${row.org_id}`); } }
    } finally { syncing = false; }
  }
  void refresh();
  const refreshTimer = setInterval(() => void refresh(), 15000);
  const syncTimer = setInterval(() => void sync().catch(() => console.warn('[integrations] Scheduled sync failed.')), 30 * 60 * 1000);
  let discovering = false;
  async function discover() {
    if (discovering || stopping) return;
    discovering = true;
    try { await runDueSlackOnboarding(); } catch { console.warn('[integrations] Slack onboarding scan failed.'); }
    finally { discovering = false; }
  }
  void discover();
  const discoveryTimer = setInterval(() => void discover(), 60 * 60 * 1000);
  return async () => { stopping = true; clearInterval(refreshTimer); clearInterval(syncTimer); clearInterval(discoveryTimer); await Promise.all([...sockets.values()].map(socket => socket.app.stop())); };
}
