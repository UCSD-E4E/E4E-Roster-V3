import { createSign } from 'crypto';
import { WebClient } from '@slack/web-api';
import { Connection, secret } from './config';

export interface Destination { id: string; name: string }
export interface SlackWorkspaceMember { id: string; email: string }
export interface SlackAdapter {
  verify(): Promise<void>;
  destinations(): Promise<Destination[]>;
  memberEmail(userId: string): Promise<string | null>;
  grant(channelId: string, userId: string): Promise<string>;
  members(): Promise<SlackWorkspaceMember[]>;
  directMessage(userId: string, text: string): Promise<void>;
  sendMessage(channelId: string, text: string): Promise<void>;
}
export interface GithubAdapter {
  verify(): Promise<void>;
  destinations(): Promise<Destination[]>;
  grant(teamSlug: string, username: string): Promise<string>;
}
export interface Adapters { slack(connection: Connection): SlackAdapter; github(connection: Connection): GithubAdapter }

class SlackProvider implements SlackAdapter {
  private client: WebClient;
  constructor(private connection: Connection) { this.client = new WebClient(secret(connection, 'botToken'), { timeout: 15000, retryConfig: { retries: 1 } }); }
  async verify() {
    const result = await this.client.auth.test();
    if (result.team_id !== this.connection.config.teamId) throw new Error('Slack token belongs to a different workspace.');
  }
  async members() {
    await this.verify();
    const members: SlackWorkspaceMember[] = [];
    for await (const page of this.client.paginate('users.list', { limit: 200 })) {
      for (const user of (page as { members?: Array<{ id?: string; team_id?: string; deleted?: boolean; is_bot?: boolean; is_app_user?: boolean; is_restricted?: boolean; is_ultra_restricted?: boolean; profile?: { email?: string } }> }).members ?? []) {
        if (!user.id || user.id === 'USLACKBOT' || user.deleted || user.is_bot || user.is_app_user || user.is_restricted || user.is_ultra_restricted || user.team_id !== this.connection.config.teamId || !user.profile?.email) continue;
        members.push({ id: user.id, email: user.profile.email.trim().toLowerCase() });
      }
    }
    return members;
  }
  async directMessage(userId: string, text: string) {
    await this.verify();
    const result = await this.client.conversations.open({ users: userId });
    if (!result.channel?.id) throw new Error('Could not open a Slack direct message.');
    await this.sendMessage(result.channel.id, text);
  }
  async sendMessage(channelId: string, text: string) {
    await this.verify();
    await this.client.chat.postMessage({ channel: channelId, text, unfurl_links: false, unfurl_media: false });
  }
  async destinations() {
    await this.verify();
    const result: Destination[] = [];
    for await (const page of this.client.paginate('conversations.list', { types: 'public_channel,private_channel', exclude_archived: true, limit: 200 })) {
      for (const c of (page as { channels?: Array<{ id: string; name: string }> }).channels ?? []) result.push({ id: c.id, name: c.name });
    }
    return result;
  }
  async memberEmail(userId: string) {
    await this.verify();
    const result = await this.client.users.info({ user: userId });
    if (result.user?.team_id !== this.connection.config.teamId) throw new Error('Slack member belongs to a different workspace.');
    if (result.user?.deleted || result.user?.is_bot) throw new Error('Slack account is inactive or a bot.');
    return result.user?.profile?.email?.toLowerCase() ?? null;
  }
  async grant(channelId: string, userId: string) {
    await this.verify();
    try { await this.client.conversations.join({ channel: channelId }); } catch (error) {
      const code = (error as { data?: { error?: string } }).data?.error;
      if (code !== 'method_not_supported_for_channel_type' && code !== 'already_in_channel') throw error;
    }
    try { await this.client.conversations.invite({ channel: channelId, users: userId }); return 'invited'; }
    catch (error) {
      if ((error as { data?: { error?: string } }).data?.error === 'already_in_channel') return 'already_member';
      throw error;
    }
  }
}

class GithubRequestError extends Error {
  constructor(readonly status: number) { super(`GitHub request failed (${status}); check installation permissions and target.`); }
}

export function integrationFailure(error: unknown): string {
  if (error instanceof GithubRequestError) return error.message;
  const slackCode = (error as { data?: { error?: unknown } } | null)?.data?.error;
  if (typeof slackCode === 'string' && /^[a-z_]{1,80}$/.test(slackCode)) return `Slack API: ${slackCode}.`;
  return 'Provider operation failed; verify enabled state, credentials, workspace/installation ownership, and destination permissions.';
}

class GithubProvider implements GithubAdapter {
  private token?: string;
  constructor(private connection: Connection) {}
  private async request(path: string, token: string, method = 'GET', body?: unknown): Promise<unknown> {
    const response = await fetch(`https://api.github.com${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', 'User-Agent': 'Roster-integrations' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new GithubRequestError(response.status);
    return response.status === 204 ? null : response.json();
  }
  private async authenticate() {
    if (this.token) return;
    const { appId, installationId, org } = this.connection.config;
    if (!/^\d+$/.test(appId ?? '') || !/^\d+$/.test(installationId ?? '') || !org) throw new Error('Incomplete GitHub connection.');
    const now = Math.floor(Date.now() / 1000);
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ iat: now - 60, exp: now + 540, iss: appId })}`;
    const signer = createSign('RSA-SHA256'); signer.update(unsigned); signer.end();
    const jwt = `${unsigned}.${signer.sign(secret(this.connection, 'privateKey'), 'base64url')}`;
    const installation = await this.request(`/app/installations/${installationId}`, jwt) as { account?: { login: string; type: string }; permissions?: { members?: string } };
    if (installation.account?.login.toLowerCase() !== org.toLowerCase() || installation.account.type !== 'Organization') throw new Error('GitHub installation belongs to a different organization.');
    if (installation.permissions?.members !== 'write') throw new Error('GitHub installation needs Organization Members read/write permission.');
    const result = await this.request(`/app/installations/${installationId}/access_tokens`, jwt, 'POST', {}) as { token: string };
    this.token = result.token;
  }
  async verify() { await this.authenticate(); }
  async destinations() {
    await this.authenticate();
    const result: Destination[] = [];
    for (let page = 1; ; page++) {
      const teams = await this.request(`/orgs/${encodeURIComponent(this.connection.config.org)}/teams?per_page=100&page=${page}`, this.token!) as Array<{ slug: string; name: string }>;
      result.push(...teams.map(t => ({ id: t.slug, name: t.name })));
      if (teams.length < 100) return result;
    }
  }
  async grant(teamSlug: string, username: string) {
    await this.authenticate();
    const path = `/orgs/${encodeURIComponent(this.connection.config.org)}/teams/${encodeURIComponent(teamSlug)}/memberships/${encodeURIComponent(username)}`;
    // Preserve existing maintainers; PUT role=member would silently downgrade their role.
    try {
      const current = await this.request(path, this.token!) as { state: string };
      return current.state;
    } catch (error) { if (!(error instanceof GithubRequestError) || error.status !== 404) throw error; }
    const result = await this.request(path,
      this.token!, 'PUT', { role: 'member' }) as { state: string };
    return result.state; // GitHub distinguishes active membership from pending invitation.
  }
}

let adapters: Adapters = { slack: c => new SlackProvider(c), github: c => new GithubProvider(c) };
// Explicit dependency injection for the standalone demo and automated tests; never selected by stored configuration.
export function setIntegrationAdapters(value: Adapters): void { adapters = value; }
export function integrationAdapters(): Adapters { return adapters; }
