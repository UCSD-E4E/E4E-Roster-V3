// Deliberately separate from server.ts: no dotenv, OIDC, live LDAP, provider sockets, or production database.
import { randomBytes } from 'crypto';

async function main() {
  const liveProviders = process.argv.includes('--live-providers');
  const port = Number(process.env.ROSTER_DEMO_PORT ?? 3100);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid demo port.');
  const origin = `http://127.0.0.1:${port}`;
  process.env.NODE_ENV = 'test';
  process.env.DB_HOST = '127.0.0.1';
  process.env.DB_PORT = '55434';
  process.env.DB_NAME = liveProviders ? 'roster_integrations_sandbox' : 'roster_integrations_demo';
  process.env.DB_USER = 'roster_demo';
  process.env.DB_PASSWORD = 'roster_demo';
  process.env.SESSION_SECRET = randomBytes(32).toString('hex');
  if (liveProviders && !/^[a-f0-9]{64}$/i.test(process.env.ENCRYPTION_KEY ?? '')) throw new Error('Live-provider sandbox requires a persistent 64-hex-character ENCRYPTION_KEY in the environment.');
  if (!liveProviders) process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const [{ db, runMigrations }, { createApp }, { setIntegrationAdapters }, { setLdapTestOverrides }, { handleSlackCommand }, { encrypt }, express] = await Promise.all([
    import('../services/db'), import('../app'), import('../integrations/providers'), import('../services/ldap'),
    import('../integrations/slack-actions'), import('../services/crypto'), import('express'),
  ]);
  await runMigrations();
  const { rows: orgs } = await db.query<{ id: number; slug: string; name: string }>(`INSERT INTO orgs (slug, name) VALUES ('e4e-demo','E4E Demo'), ('krg-demo','KRG Demo')
    ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name RETURNING id, slug, name`);
  await db.query(`INSERT INTO users (username, first_name, last_name, email, github_username, ldap_groups, expiry_date, disabled) VALUES
    ('alice-demo','Alice','Shared','alice@example.test',CASE WHEN $1::boolean THEN NULL ELSE 'alice-demo' END,ARRAY['shared-demo'],CURRENT_DATE+10,FALSE),
    ('e4e-only-demo','Eve','E4E','eve@example.test',CASE WHEN $1::boolean THEN NULL ELSE 'eve-demo' END,ARRAY['shared-demo'],CURRENT_DATE+10,FALSE),
    ('krg-only-demo','Kai','KRG','kai@example.test',CASE WHEN $1::boolean THEN NULL ELSE 'kai-demo' END,ARRAY['shared-demo'],CURRENT_DATE+10,FALSE),
    ('disabled-demo','Disabled','Member','disabled@example.test',CASE WHEN $1::boolean THEN NULL ELSE 'disabled-demo' END,ARRAY['shared-demo'],CURRENT_DATE+10,TRUE),
    ('expired-demo','Expired','Member','expired@example.test',CASE WHEN $1::boolean THEN NULL ELSE 'expired-demo' END,ARRAY['shared-demo'],CURRENT_DATE-10,FALSE)
    ON CONFLICT (username) DO NOTHING`, [liveProviders]);
  for (const org of orgs) {
    const e4e = org.slug === 'e4e-demo'; const prefix = e4e ? 'E4E' : 'KRG';
    for (const username of ['alice-demo', e4e ? 'e4e-only-demo' : 'krg-only-demo', 'disabled-demo', 'expired-demo']) {
      await db.query('INSERT INTO user_orgs (org_id,username) VALUES ($1,$2) ON CONFLICT DO NOTHING', [org.id, username]);
    }
    await db.query("INSERT INTO org_groups (org_id,ldap_group) VALUES ($1,'shared-demo') ON CONFLICT DO NOTHING", [org.id]);
    for (const [service, config, target] of [
      ['slack', { teamId: `T${prefix}DEMO`, botToken: encrypt('fake-token') }, `C${prefix}DEMO`],
      ['github', { org: `${prefix}-demo`, appId: '123', installationId: e4e ? '1001' : '1002' }, `${prefix.toLowerCase()}-demo-team`],
    ] as const) {
      if (liveProviders) {
        await db.query(`INSERT INTO org_integrations (org_id,service,config,enabled) VALUES ($1,$2,'{}',FALSE) ON CONFLICT DO NOTHING`, [org.id, service]);
      } else {
        await db.query(`INSERT INTO org_integrations (org_id,service,config,enabled) VALUES ($1,$2,$3,TRUE)
          ON CONFLICT (org_id,service) DO UPDATE SET config=EXCLUDED.config,enabled=TRUE,updated_at=NOW()`, [org.id, service, JSON.stringify(config)]);
        await db.query(`INSERT INTO group_mappings (org_id,ldap_group,service,target_id,target_name) VALUES ($1,'shared-demo',$2,$3,$3) ON CONFLICT DO NOTHING`, [org.id, service, target]);
      }
    }
    if (!liveProviders) await db.query(`INSERT INTO integration_identities (org_id,username,service,external_id) VALUES ($1,'alice-demo','slack',$2)
      ON CONFLICT (org_id,username,service) DO UPDATE SET external_id=EXCLUDED.external_id`, [org.id, `U${prefix}ALICE`]);
  }
  const effects: Array<{ provider: string; orgId?: number; target: string; identity: string }> = [];
  if (!liveProviders) setIntegrationAdapters({
    slack: c => ({ verify: async () => {}, destinations: async () => [{ id: `C${c.config.teamId.slice(1,4)}DEMO`, name: 'demo-channel' }],
      memberEmail: async id => {
        const prefix = c.config.teamId === 'TE4EDEMO' ? 'UE4E' : 'UKRG';
        if (!id.startsWith(prefix)) throw new Error('Slack member belongs to a different workspace.');
        return id.includes('ALICE') ? 'alice@example.test' : id.includes('EVE') ? 'eve@example.test' : null;
      },
      grant: async (target, identity) => { effects.push({ provider: 'Slack (simulated)', orgId: c.orgId, target, identity }); return 'simulated_invitation'; } }),
    github: c => ({ verify: async () => {}, destinations: async () => [{ id: `${c.config.org.toLowerCase()}-team`, name: 'Demo team' }],
      grant: async (target, identity) => { effects.push({ provider: 'GitHub (simulated)', orgId: c.orgId, target, identity }); return 'simulated_active'; } }),
  });
  setLdapTestOverrides({ listUsers: async () => [], listGroups: async () => ['shared-demo'],
    updateUserExpiry: async (username, expiry) => { effects.push({ provider: 'LDAP (simulated)', identity: username, target: expiry ?? 'never' }); return { status: 'success', message: 'Simulated LDAP update' }; },
    createGroup: async () => ({ status: 'success', message: 'Simulated group creation' }),
    createUser: async () => ({ status: 'failed', message: 'User provisioning is outside this integration demo.' }),
    updateUserGroups: async () => ({ status: 'success', message: 'Simulated' }),
    updateUserProfile: async () => ({ status: 'success', message: 'Simulated' }),
    setSshKeys: async () => ({ status: 'success', message: 'Simulated' }),
  });
  const stopIntegrations = liveProviders ? (await import('../integrations/runtime')).startIntegrationRuntime() : async () => {};
  const admin = { id: 'integration-demo', username: 'demo-admin', name: 'Local Demo Admin', email: 'demo@example.test', groups: [], isSystemAdmin: true, isLocalAdmin: true, orgs: [] };
  const app = express.default();
  app.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use(express.urlencoded({ extended: false }));
  const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
  app.get('/demo', (_req, res) => {
    res.type('html').send(`<!doctype html><html><head><title>Roster integration prototype</title><style>body{font:17px system-ui;max-width:1050px;margin:48px auto;padding:0 24px;background:#f4f6f9;color:#182b49}section{background:white;padding:24px;margin:20px 0;border-radius:12px}button,a{margin:8px}td,th{padding:9px;text-align:left}code{background:#eef;padding:3px}</style></head><body>
      <h1>Roster integration prototype</h1><p>${liveProviders ? 'LIVE Slack/GitHub sandbox · provider operations affect the connected test organizations · LDAP remains simulated' : 'Local simulation · existing roster backend · no real Slack, GitHub, or LDAP calls'}</p>
      <section><h2>1. Explore organization settings</h2>${orgs.map(o => `<p><a href="/orgs/${escape(o.slug)}/v2/settings">${escape(o.name)}: credentials, identities, grant preview, apply, activity</a> · <a href="/orgs/${escape(o.slug)}/v2/settings/groups?group=shared-demo">Group destinations</a></p>`).join('')}
      <p>Alice belongs to both organizations with different Slack IDs. Eve and Kai belong to one each despite sharing the same LDAP group. Disabled and expired accounts are excluded.</p></section>
      <section><h2>2. Simulate a Slack command</h2><p>${liveProviders ? 'Use /roster-check and /roster-extend in the connected test Slack workspace. This form uses the simulated workspace IDs and is only useful in simulation mode.' : 'These call the same command handler used by real Slack Socket Mode.'}</p><form method="post" action="/demo/command"><label>Workspace <select name="teamId"><option>TE4EDEMO</option><option>TKRGDEMO</option></select></label> <label>User <select name="userId"><option>UE4EALICE</option><option>UKRGALICE</option><option>UE4EEVE</option><option>UUNKNOWN</option></select></label> <select name="command"><option>/roster-check</option><option>/roster-extend</option></select><button>Run command</button></form><p>Try Alice’s E4E identity in KRG: it must be rejected. Extend Alice in E4E, then check in KRG: the shared date changes in both.</p></section>
      <section><h2>3. Simulated external effects</h2><p>Reload this page after applying grants or extending an account.</p><table><tr><th>Provider</th><th>Organization ID</th><th>Identity</th><th>Destination / expiration</th></tr>${effects.slice(-40).reverse().map(e => `<tr><td>${escape(e.provider)}</td><td>${e.orgId ?? 'shared'}</td><td>${escape(e.identity)}</td><td>${escape(e.target)}</td></tr>`).join('')}</table></section></body></html>`);
  });
  app.post('/demo/command', async (req, res) => {
    if (req.get('origin') !== origin) { res.status(403).send(`Use the form at ${origin}/demo.`); return; }
    let message: string;
    try { message = await handleSlackCommand(String(req.body.teamId), String(req.body.userId), String(req.body.command)); }
    catch (error) { message = error instanceof Error ? error.message : 'Failed'; }
    res.type('html').send(`<h1>Slack response (simulated, ephemeral)</h1><pre>${escape(message)}</pre><a href="/demo">Back to demo</a>`);
  });
  app.get('/', (_req, res) => res.redirect('/demo'));
  app.use(createApp({ testUserFromRequest: () => admin }));
  const server = app.listen(port, '127.0.0.1', () => console.log(`Integration demo: ${origin}/demo (${liveProviders ? 'LIVE Slack/GitHub; simulated LDAP' : 'simulated providers'}, isolated database)`));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => void stopIntegrations().finally(() => server.close(() => void db.end().then(() => process.exit(0)))));
}
void main().catch(error => { console.error(error instanceof Error ? error.message : 'Demo failed'); process.exit(1); });
