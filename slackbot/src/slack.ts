/**
 * Slack API client and workspace member helpers.
 *
 * Uses a Bot User OAuth Token (xoxb-...) with scopes:
 *   users:read, users:read.email
 */
import { WebClient } from '@slack/web-api';

let _client: WebClient | null = null;

function getClient(): WebClient {
  if (!_client) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error('Missing required env var: SLACK_BOT_TOKEN');
    _client = new WebClient(token);
  }
  return _client;
}

export interface SlackMember {
  id: string;           // Slack member ID (U01234567) — stable identifier
  username: string;     // display name / handle
  realName: string;
  email: string | null;
  isBot: boolean;
  deleted: boolean;     // deactivated accounts
}

/** Fetch all non-bot, non-deleted workspace members. */
export async function listWorkspaceMembers(): Promise<SlackMember[]> {
  const client = getClient();
  const members: SlackMember[] = [];

  for await (const page of client.paginate('users.list', { limit: 200 })) {
    const users = (page as { members?: unknown[] }).members ?? [];
    for (const u of users as Record<string, unknown>[]) {
      // Skip bots and Slackbot
      if (u['is_bot'] || u['id'] === 'USLACKBOT') continue;

      const profile = (u['profile'] ?? {}) as Record<string, unknown>;
      members.push({
        id: u['id'] as string,
        username: (profile['display_name'] as string) || (u['name'] as string),
        realName: (profile['real_name'] as string) ?? '',
        email: (profile['email'] as string) ?? null,
        isBot: false,
        deleted: (u['deleted'] as boolean) ?? false,
      });
    }
  }

  return members;
}
