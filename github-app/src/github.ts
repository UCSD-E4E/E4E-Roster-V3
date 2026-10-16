/**
 * GitHub App client.
 *
 * Authentication flow:
 *   App private key → JWT → installation token (per-org, short-lived)
 *
 * All API calls use the installation token, not a PAT.
 *
 * Multi-tenant: pass orgId to any exported function to load credentials
 * from the org_integrations DB table. Omit orgId to fall back to env vars
 * (used by background sync and webhooks).
 */
import fs from 'fs';
import path from 'path';
import { createDecipheriv } from 'crypto';
import { App } from '@octokit/app';
import { db } from './db.js';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

function loadPrivateKey(): string {
  const keyPath = requireEnv('GITHUB_APP_PRIVATE_KEY_PATH');
  const resolved = path.resolve(keyPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`GitHub App private key not found at: ${resolved}`);
  }
  return fs.readFileSync(resolved, 'utf8');
}

// AES-256-GCM decrypt — must stay in sync with backend/src/services/crypto.ts (decrypt).
// Duplicated here because the github-app is a separate Docker service with its own package.
function decryptField(ciphertext: string): string {
  const hexKey = process.env.ENCRYPTION_KEY;
  if (!hexKey || hexKey.length !== 64) throw new Error('ENCRYPTION_KEY not set');
  const key  = Buffer.from(hexKey, 'hex');
  const data = Buffer.from(ciphertext, 'base64');
  const iv   = data.subarray(0, 12);
  const tag  = data.subarray(12, 28);
  const enc  = data.subarray(28);
  const dc   = createDecipheriv('aes-256-gcm', key, iv);
  dc.setAuthTag(tag);
  return Buffer.concat([dc.update(enc), dc.final()]).toString('utf8');
}

// ── Singleton App for webhooks and background sync (env-var credentials) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _app: App<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getApp(): App<any> {
  if (!_app) {
    _app = new App({
      appId:    requireEnv('GITHUB_APP_ID'),
      privateKey: loadPrivateKey(),
      webhooks: { secret: requireEnv('GITHUB_WEBHOOK_SECRET') },
    });
  }
  return _app;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getInstallationId(org: string, app: App<any> = getApp()): Promise<number> {
  const { data } = await app.octokit.request('GET /orgs/{org}/installation', { org });
  return data.id;
}

// ── Per-org credential lookup ─────────────────────────────────────────────────

interface OrgContext {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  octokit: any;
  org: string;
}

/**
 * Returns an authenticated installation Octokit and the GitHub org name.
 *
 * If orgId is given: loads credentials from org_integrations (DB + decrypt).
 * If orgId is omitted: falls back to env vars (background sync / webhooks).
 *
 * Returns null if credentials are missing or invalid.
 */
async function getOctokitForOrg(orgId?: number): Promise<OrgContext | null> {
  if (orgId !== undefined) {
    const { rows } = await db.query<{ config: Record<string, string>; enabled: boolean }>(
      'SELECT config, enabled FROM org_integrations WHERE org_id = $1 AND service = $2',
      [orgId, 'github'],
    );
    const row = rows[0];
    if (!row?.enabled || !row.config.privateKey) {
      console.warn(`[github] No enabled GitHub credentials for org ${orgId}`);
      return null;
    }
    try {
      const privateKey = decryptField(row.config.privateKey);
      const org = row.config.org;
      const app = new App({
        appId:    parseInt(row.config.appId, 10),
        privateKey,
        webhooks: { secret: process.env.GITHUB_WEBHOOK_SECRET ?? '' },
      });
      const installationId = row.config.installationId
        ? parseInt(row.config.installationId, 10)
        : await getInstallationId(org, app);
      const octokit = await app.getInstallationOctokit(installationId);
      return { octokit, org };
    } catch (err) {
      console.warn(`[github] Failed to initialise credentials for org ${orgId}:`, err);
      return null;
    }
  }

  // Env-var fallback (background sync and webhooks)
  try {
    const org = requireEnv('GITHUB_ORG');
    const installationId = await getInstallationId(org);
    const octokit = await getApp().getInstallationOctokit(installationId);
    return { octokit, org };
  } catch (err) {
    console.warn('[github] Failed to get env-var credentials:', err);
    return null;
  }
}

// ── Exported API helpers ──────────────────────────────────────────

export interface OrgMember {
  login: string;
  id: number;
  name: string | null;
  email: string | null;
}

/** List all members of the GitHub org. */
export async function listOrgMembers(orgId?: number): Promise<OrgMember[]> {
  const ctx = await getOctokitForOrg(orgId);
  if (!ctx) return [];
  const { octokit, org } = ctx;

  const members: OrgMember[] = [];
  let page = 1;
  while (true) {
    const { data, headers } = await octokit.request('GET /orgs/{org}/members', { org, per_page: 100, page });
    console.log(`[github] got ${data.length} members on page ${page}, link: ${headers?.link ?? 'none'}`);
    for (const m of data) {
      const { data: user } = await octokit.request('GET /users/{username}', { username: m.login });
      members.push({ login: m.login, id: m.id, name: user.name ?? null, email: user.email ?? null });
    }
    if (data.length < 100) break;
    page++;
  }
  return members;
}

/** List all teams in the org. */
export async function listTeams(orgId?: number): Promise<{ slug: string; name: string }[]> {
  const ctx = await getOctokitForOrg(orgId);
  if (!ctx) return [];
  const { octokit, org } = ctx;

  const teams: { slug: string; name: string }[] = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.request('GET /orgs/{org}/teams', { org, per_page: 100, page });
    teams.push(...data.map((t: { slug: string; name: string }) => ({ slug: t.slug, name: t.name })));
    if (data.length < 100) break;
    page++;
  }
  return teams;
}

/** Invite a GitHub user to the org and optionally add them to teams. */
export async function inviteToOrg(githubUsername: string, teamSlugs: string[] = [], orgId?: number): Promise<void> {
  const ctx = await getOctokitForOrg(orgId);
  if (!ctx) throw new Error(`GitHub not configured${orgId !== undefined ? ` for org ${orgId}` : ''}`);
  const { octokit, org } = ctx;

  const { data: user } = await octokit.request('GET /users/{username}', { username: githubUsername });

  const teamIds = await Promise.all(
    teamSlugs.map(async (slug: string) => {
      const { data: team } = await octokit.request('GET /orgs/{org}/teams/{team_slug}', { org, team_slug: slug });
      return team.id;
    }),
  );

  await octokit.request('POST /orgs/{org}/invitations', {
    org,
    invitee_id: user.id,
    team_ids: teamIds,
  });
}

/** Add a GitHub user to an org team. Idempotent — safe to call if already a member. */
export async function addToTeam(githubUsername: string, teamSlug: string, orgId?: number): Promise<void> {
  const ctx = await getOctokitForOrg(orgId);
  if (!ctx) throw new Error(`GitHub not configured${orgId !== undefined ? ` for org ${orgId}` : ''}`);
  const { octokit, org } = ctx;

  await octokit.request('PUT /orgs/{org}/teams/{team_slug}/memberships/{username}', {
    org,
    team_slug: teamSlug,
    username: githubUsername,
  });
}

export function getWebhooks() {
  return getApp().webhooks;
}
