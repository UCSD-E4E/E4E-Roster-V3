/**
 * GitHub App client.
 *
 * Authentication flow:
 *   App private key → JWT → installation token (per-org, short-lived)
 *
 * All API calls use the installation token, not a PAT.
 */
import { App } from '@octokit/app';

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

let _app: App | null = null;

function getApp(): App {
  if (!_app) {
    _app = new App({
      appId: requireEnv('GITHUB_APP_ID'),
      // Private key PEM — store as env var with literal \n or as a mounted file
      privateKey: requireEnv('GITHUB_APP_PRIVATE_KEY').replace(/\\n/g, '\n'),
      webhooks: { secret: requireEnv('GITHUB_WEBHOOK_SECRET') },
    });
  }
  return _app;
}

/** Returns an Octokit instance authenticated as the app installation for the org. */
async function getOctokit() {
  const app = getApp();
  const org = requireEnv('GITHUB_ORG');
  const { data: installation } = await (await app.getInstallationOctokit(
    await getInstallationId(org),
  )).request('GET /app');

  // Re-fetch as installation octokit
  const installationId = await getInstallationId(org);
  return app.getInstallationOctokit(installationId);
}

async function getInstallationId(org: string): Promise<number> {
  const app = getApp();
  const octokit = await app.octokit.request('GET /orgs/{org}/installation', { org });
  return octokit.data.id;
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
  for await (const { data } of octokit.paginate.iterator(
    octokit.rest.orgs.listMembers,
    { org, per_page: 100 },
  )) {
    for (const m of data) {
      // Fetch public profile for name/email
      const { data: user } = await octokit.rest.users.getByUsername({ username: m.login });
      members.push({ login: m.login, id: m.id, name: user.name ?? null, email: user.email ?? null });
    }
  }
  return members;
}

/** List all teams in the org. */
export async function listTeams(): Promise<{ slug: string; name: string }[]> {
  const octokit = await getOctokit();
  const org = requireEnv('GITHUB_ORG');
  const teams: { slug: string; name: string }[] = [];
  for await (const { data } of octokit.paginate.iterator(
    octokit.rest.teams.list,
    { org, per_page: 100 },
  )) {
    teams.push(...data.map((t) => ({ slug: t.slug, name: t.name })));
  }
  return teams;
}

/** Invite a GitHub user to the org and optionally add them to teams. */
export async function inviteToOrg(githubUsername: string, teamSlugs: string[] = []): Promise<void> {
  const octokit = await getOctokit();
  const org = requireEnv('GITHUB_ORG');

  // Resolve username to numeric ID (required for invitation)
  const { data: user } = await octokit.rest.users.getByUsername({ username: githubUsername });

  const teamIds = await Promise.all(
    teamSlugs.map(async (slug) => {
      const { data: team } = await octokit.rest.teams.getByName({ org, team_slug: slug });
      return team.id;
    }),
  );

  await octokit.rest.orgs.createInvitation({
    org,
    invitee_id: user.id,
    team_ids: teamIds,
  });
}

export function getWebhooks() {
  return getApp().webhooks;
}
