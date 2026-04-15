/**
 * /check slash command
 *
 * Shows the user their roster entry and highlights any missing links.
 * If GitHub username is missing, prompts them to add it via a modal.
 */
import type { App } from '@slack/bolt';
import { db } from '../db';

interface RosterUser {
  username: string;
  first_name: string;
  last_name: string;
  email: string;
  role: string | null;
  expiry_date: string | null;
  github_username: string | null;
  slack_username: string | null;
  ldap_groups: string[];
}

export function registerCheckCommand(app: App): void {
  app.command('/check', async ({ command, ack, respond }) => {
    await ack();

    const slackUserId = command.user_id;

    // Look up by Slack member ID
    const { rows } = await db.query<RosterUser>(
      `SELECT username, first_name, last_name, email, role,
              TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date,
              github_username, slack_username, ldap_groups
       FROM users WHERE slack_username = $1`,
      [slackUserId],
    );

    if (!rows.length) {
      await respond({
        response_type: 'ephemeral',
        text: 'You don\'t appear to be in the E4E roster yet. Contact a Project Lead to get added.',
      });
      return;
    }

    const user = rows[0];
    const missing: string[] = [];
    if (!user.github_username) missing.push('GitHub username');

    const groupList = user.ldap_groups?.length
      ? user.ldap_groups.join(', ')
      : '_none_';

    const blocks = [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Your E4E Roster Entry' },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Username:*\n\`${user.username}\`` },
          { type: 'mrkdwn', text: `*Name:*\n${user.first_name} ${user.last_name}` },
          { type: 'mrkdwn', text: `*Email:*\n${user.email}` },
          { type: 'mrkdwn', text: `*Role:*\n${user.role ?? '_not set_'}` },
          { type: 'mrkdwn', text: `*Account expiry:*\n${user.expiry_date ?? 'No expiry'}` },
          { type: 'mrkdwn', text: `*GitHub:*\n${user.github_username ? `\`${user.github_username}\`` : '_not linked_'}` },
        ],
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*LDAP Groups:*\n${groupList}` },
      },
    ];

    // If anything is missing, add a prompt block with an action button
    if (missing.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:warning: *Missing info:* ${missing.join(', ')}`,
        },
      } as never);

      if (!user.github_username) {
        blocks.push({
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Link GitHub account' },
              action_id: 'open_github_modal',
              style: 'primary',
            },
          ],
        } as never);
      }
    }

    await respond({
      response_type: 'ephemeral',
      text: 'Your E4E roster entry',
      blocks,
    });
  });

  // Button opens a modal to enter GitHub username
  app.action('open_github_modal', async ({ body, ack, client }) => {
    await ack();
    await client.views.open({
      trigger_id: (body as { trigger_id: string }).trigger_id,
      view: {
        type: 'modal',
        callback_id: 'submit_github_username',
        title: { type: 'plain_text', text: 'Link GitHub Account' },
        submit: { type: 'plain_text', text: 'Save' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: 'github_block',
            element: {
              type: 'plain_text_input',
              action_id: 'github_username_input',
              placeholder: { type: 'plain_text', text: 'e.g. octocat' },
            },
            label: { type: 'plain_text', text: 'Your GitHub username' },
          },
        ],
        private_metadata: body.user.id,
      },
    });
  });

  // Modal submission — save GitHub username to DB
  app.view('submit_github_username', async ({ ack, view, body }) => {
    await ack();

    const slackUserId = view.private_metadata || body.user.id;
    const githubUsername =
      view.state.values['github_block']['github_username_input'].value?.trim() ?? '';

    if (!githubUsername) return;

    await db.query(
      'UPDATE users SET github_username = $1, updated_at = NOW() WHERE slack_username = $2',
      [githubUsername, slackUserId],
    );

    console.log(`[check] ${slackUserId} linked GitHub username: ${githubUsername}`);
  });
}
