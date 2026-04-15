/**
 * GitHub App client.
 *
 * Authentication flow:
 *   App private key → JWT → installation token (per-org, short-lived)
 *
 * All API calls use the installation token, not a PAT.
 */
import fs from 'fs';
import path from 'path';
import { App } from '@octokit/app';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _app: App<any> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getApp(): App<any> {
  if (!_app) {
    _app = new App({
      appId: requireEnv('GITHUB_APP_ID'),
      privateKey: loadPrivateKey(),
      webhooks: { secret: requireEnv('GITHUB_WEBHOOK_SECRET') },
    });
  }
  return _app;
}

async function getInstallationId(org: string): Promise<number> {
  const app = getApp();
  const { data } = await app.octokit.request('GET /orgs/{org}/installation', { org });
  return data.id;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getOctokit(): Promise<any> {
  const installationId = await getInstallationId(requireEnv('GITHUB_ORG'));
  return getApp().getInstallationOctokit(installationId);
}

// ── Exported API helpers ──────────────────────────────────────────

export interface OrgMember {
  login: string;
  id: number;
  name: string | null;
  email: string | null;
}

/** List all members of the GitHub org. */
export async function listOrgMembers(): Promise<OrgMember[]> {
  const octokit = await getOctokit();
  const org = requireEnv('GITHUB_ORG');

  const members: OrgMember[] = [];
  let page = 1;
  while (true) {
    console.log(`[github] GET /orgs/${org}/members?per_page=100&page=${page}`);
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
export async function listTeams(): Promise<{ slug: string; name: string }[]> {
  const octokit = await getOctokit();
  const org = requireEnv('GITHUB_ORG');
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
export async function inviteToOrg(githubUsername: string, teamSlugs: string[] = []): Promise<void> {
  const octokit = await getOctokit();
  const org = requireEnv('GITHUB_ORG');

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
export async function addToTeam(githubUsername: string, teamSlug: string): Promise<void> {
  const octokit = await getOctokit();
  const org = requireEnv('GITHUB_ORG');
  await octokit.request('PUT /orgs/{org}/teams/{team_slug}/memberships/{username}', {
    org,
    team_slug: teamSlug,
    username: githubUsername,
  });
}

export function getWebhooks() {
  return getApp().webhooks;
}
