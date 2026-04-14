/**
 * /extend slash command
 *
 * Extends the invoking user's account expiry by 90 days (from current expiry,
 * or from today if no expiry is set). Any Slack member can run this.
 * The updated date is written to the DB; the next sync cycle pushes it to LDAP.
 */
import type { App } from '@slack/bolt';
import { db } from '../db';

const EXTENSION_DAYS = 90;

export function registerExtendCommand(app: App): void {
  app.command('/extend', async ({ command, ack, respond }) => {
    await ack();

    const slackUserId = command.user_id;

    const { rows } = await db.query<{
      username: string;
      first_name: string;
      expiry_date: string | null;
    }>(
      `SELECT username, first_name, TO_CHAR(expiry_date, 'YYYY-MM-DD') AS expiry_date
       FROM users WHERE slack_username = $1`,
      [slackUserId],
    );

    if (!rows.length) {
      await respond({
        response_type: 'ephemeral',
        text: "You don't appear to be in the E4E roster yet. Contact a Project Lead to get added.",
      });
      return;
    }

    const user = rows[0];
    const base = user.expiry_date ? new Date(user.expiry_date) : new Date();
    base.setDate(base.getDate() + EXTENSION_DAYS);
    const newExpiry = base.toISOString().slice(0, 10); // YYYY-MM-DD

    await db.query(
      `UPDATE users SET expiry_date = $1, updated_at = NOW() WHERE slack_username = $2`,
      [newExpiry, slackUserId],
    );

    console.log(`[extend] ${user.username} extended expiry to ${newExpiry}`);

    await respond({
      response_type: 'ephemeral',
      text: `Account extended to ${newExpiry}`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text:
              `:white_check_mark: Your account access has been extended by ${EXTENSION_DAYS} days.\n\n` +
              `*New expiry:* ${newExpiry}`,
          },
        },
        {
          type: 'context',
          elements: [
            {
              type: 'mrkdwn',
              text: 'You can run `/extend` again at any time.',
            },
          ],
        },
      ],
    });
  });
}
