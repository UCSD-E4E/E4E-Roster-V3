import 'dotenv/config';
import { App } from '@slack/bolt';
import { syncSlack } from './sync';
import { sendPostSyncNotifications } from './notify';
import { registerCheckCommand } from './commands/check';
import { registerExtendCommand } from './commands/extend';

const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function bootstrap() {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
  });

  registerCheckCommand(app);
  registerExtendCommand(app);

  await app.start();
  console.log('E4E Slack bot running (socket mode)');

  await runSync(app);
  setInterval(() => runSync(app), SYNC_INTERVAL_MS);
}

async function runSync(app: App) {
  try {
    const report = await syncSlack();

    if (report.inSlackNotRoster.length > 0) {
      console.warn(`[slack-sync] ${report.inSlackNotRoster.length} Slack member(s) not in roster`);
    }
    if (report.inRosterNotSlack.length > 0) {
      console.warn(`[slack-sync] ${report.inRosterNotSlack.length} roster user(s) not found in Slack`);
    }

    await sendPostSyncNotifications(app.client, report);
  } catch (err) {
    console.error('[slack-sync] sync failed:', err);
  }
}

bootstrap().catch((err) => {
  console.error('Failed to start Slack bot:', err);
  process.exit(1);
});
