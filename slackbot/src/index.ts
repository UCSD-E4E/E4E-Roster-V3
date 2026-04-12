import 'dotenv/config';
import { syncSlack } from './sync';

const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

async function bootstrap() {
  console.log('E4E Slack bot starting');

  // Run once on startup, then on interval
  await runSync();
  setInterval(runSync, SYNC_INTERVAL_MS);
}

async function runSync() {
  try {
    const report = await syncSlack();
    if (report.inSlackNotRoster.length > 0) {
      console.warn(
        `[slack-sync] ${report.inSlackNotRoster.length} Slack member(s) not in roster:`,
        report.inSlackNotRoster.map((m) => `${m.realName} (${m.email ?? m.username})`).join(', '),
      );
    }
    if (report.inRosterNotSlack.length > 0) {
      console.warn(
        `[slack-sync] ${report.inRosterNotSlack.length} roster user(s) not found in Slack:`,
        report.inRosterNotSlack.map((u) => u.username).join(', '),
      );
    }
  } catch (err) {
    console.error('[slack-sync] sync failed:', err);
  }
}

bootstrap().catch((err) => {
  console.error('Failed to start Slack bot:', err);
  process.exit(1);
});
