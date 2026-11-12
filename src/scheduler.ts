import { Cron } from 'croner';
import type { Client } from 'discord.js';
import { runDailyLifecycle } from './services/channelManager.js';

export function startDailyScheduler(client: Client): Cron {
  console.log('[Scheduler] Initializing daily lifecycle cron job at 00:00:00 JST...');

  const job = new Cron(
    '0 0 0 * * *',
    {
      timezone: 'Asia/Tokyo',
      catch: (err) => {
        console.error('[Scheduler] Error occurred in cron job handler:', err);
      },
    },
    async () => {
      console.log(`[Scheduler] Daily batch triggered at ${new Date().toISOString()}`);
      try {
        const result = await runDailyLifecycle(client);
        console.log(
          `[Scheduler] Daily batch finished successfully.\n` +
            `  - Created: ${result.created ? `#${result.createdChannelName}` : 'Already exists'}\n` +
            `  - Confirm sent: ${result.confirmSentChannels.length} (${result.confirmSentChannels.join(', ') || 'none'})\n` +
            `  - Deleted: ${result.deletedChannels.length} (${result.deletedChannels.join(', ') || 'none'})\n` +
            `  - Errors: ${result.errors.length}`
        );
      } catch (error) {
        console.error('[Scheduler] Failed to execute daily lifecycle:', error);
      }
    }
  );

  const nextRun = job.nextRun();
  console.log(
    `[Scheduler] Cron scheduled. Next run at: ${nextRun ? nextRun.toISOString() : 'unknown'} (${
      nextRun?.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) ?? ''
    } JST)`
  );

  return job;
}
