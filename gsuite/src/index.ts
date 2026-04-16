import 'dotenv/config';
import http from 'http';
import { addMember, listGroups } from './groups.js';
import { db } from './db.js';

const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// ── Group sync ────────────────────────────────────────────────────

async function runGroupSync(): Promise<{ ops: number; errors: number }> {
  type MappingRow = { ldap_group: string; target_id: string };
  type UserRow    = { email: string; ldap_groups: string[] };

  const [{ rows: mappings }, { rows: users }] = await Promise.all([
    db.query<MappingRow>('SELECT ldap_group, target_id FROM group_mappings WHERE service = $1', ['google']),
    db.query<UserRow>('SELECT email, ldap_groups FROM users WHERE email IS NOT NULL'),
  ]);

  if (mappings.length === 0) return { ops: 0, errors: 0 };

  // Index mappings: ldap_group → [google group emails]
  const googleByGroup = new Map<string, string[]>();
  for (const m of mappings) {
    const list = googleByGroup.get(m.ldap_group) ?? [];
    list.push(m.target_id);
    googleByGroup.set(m.ldap_group, list);
  }

  let ops = 0, errors = 0;

  for (const user of users) {
    for (const ldapGroup of (user.ldap_groups ?? [])) {
      for (const groupEmail of (googleByGroup.get(ldapGroup) ?? [])) {
        try {
          const result = await addMember(groupEmail, user.email);
          if (result === 'added') ops++;
        } catch (err) {
          console.warn(`[gsuite-sync] failed to add ${user.email} to ${groupEmail}:`, err);
          errors++;
        }
      }
    }
  }

  console.log(`[gsuite-sync] done — ${ops} member(s) added, ${errors} error(s)`);
  return { ops, errors };
}

// ── Startup ───────────────────────────────────────────────────────

async function bootstrap() {
  startServer();

  // Initial sync — delay slightly to let DB settle
  setTimeout(async () => {
    try {
      await runGroupSync();
    } catch (err) {
      console.error('[gsuite-sync] initial sync failed:', err);
    }
  }, 5000);

  setInterval(async () => {
    try {
      await runGroupSync();
    } catch (err) {
      console.error('[gsuite-sync] sync failed:', err);
    }
  }, SYNC_INTERVAL_MS);
}

bootstrap().catch((err) => {
  console.error('Failed to start gsuite service:', err);
  process.exit(1);
});

// ── Internal HTTP server ──────────────────────────────────────────

function startServer(): void {
  const port = parseInt(process.env.GSUITE_INTERNAL_PORT ?? '3003', 10);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);

    // GET /health
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /groups — list all Google Groups in domain
    if (req.method === 'GET' && url.pathname === '/groups') {
      try {
        const groups = await listGroups();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(groups));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
      return;
    }

    // POST /invite — add a user to a Google Group
    if (req.method === 'POST' && url.pathname === '/invite') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        try {
          const { groupEmail, userEmail } = JSON.parse(body) as {
            groupEmail?: string;
            userEmail?: string;
          };
          if (!groupEmail || !userEmail) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'groupEmail and userEmail required' }));
            return;
          }
          const result = await addMember(groupEmail, userEmail);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, result }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      return;
    }

    // POST /sync — trigger an immediate group sync
    if (req.method === 'POST' && url.pathname === '/sync') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Kick off async, respond immediately
      runGroupSync()
        .then((r) => console.log(`[gsuite-sync] manual sync — ${r.ops} ops, ${r.errors} errors`))
        .catch((err) => console.error('[gsuite-sync] manual sync failed:', err));
      res.end(JSON.stringify({ ok: true, message: 'sync started' }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () =>
    console.log(`[gsuite] internal API listening on port ${port}`),
  );
}
