import { Cron } from 'croner';
import type { Client } from 'discord.js';
import { runDailyLifecycle } from './services/channelManager.js';
import { runForumCleanup } from './services/forumManager.js';
import { pendingAssignmentTopic, startAssignmentPosting } from './services/assignmentPosting.js';

export interface DailyScheduler {
  nextRun(): Date | null;
  stop(): void;
}

export function startDailyScheduler(client: Client): DailyScheduler {
  console.log('[Scheduler] Initializing daily lifecycle cron job at 00:00:00 JST...');

  const assignmentPosting = startAssignmentPosting(client);
  const job = new Cron(
    '0 0 0 * * *',
    {
      timezone: 'Asia/Tokyo',
      catch: (err) => {
        console.error('[Scheduler] Error occurred in cron job handler:', err);
      },
    },
    async () => {
      const referenceDate = new Date();
      console.log(`[Scheduler] Daily batch triggered at ${referenceDate.toISOString()}`);

      // 1. Disposable daily channel lifecycle
      try {
        const result = await runDailyLifecycle(client, referenceDate, {
          createTopic: pendingAssignmentTopic(referenceDate),
        });
        console.log(
          `[Scheduler] Disposable channel batch finished.\n` +
            `  - Created: ${result.created ? `#${result.createdChannelName}` : 'Already exists'}\n` +
            `  - Confirm sent: ${result.confirmSentChannels.length} (${result.confirmSentChannels.join(', ') || 'none'})\n` +
            `  - Deleted: ${result.deletedChannels.length} (${result.deletedChannels.join(', ') || 'none'})\n` +
            `  - Errors: ${result.errors.length}`
        );
        void assignmentPosting.post(referenceDate, result.todayChannel, result.created);
      } catch (error) {
        console.error('[Scheduler] Failed to execute daily channel lifecycle:', error);
      }

      // 2. Inactive forum thread cleanup check
      try {
        const forumResult = await runForumCleanup(client);
        console.log(
          `[Scheduler] Forum cleanup batch finished.\n` +
            `  - Forums inspected: ${forumResult.inspectedForumCount}\n` +
            `  - Threads inspected: ${forumResult.inspectedThreadCount} (pinned skipped: ${forumResult.skippedPinnedCount})\n` +
            `  - Confirm sent: ${forumResult.confirmSentThreads.length} (${forumResult.confirmSentThreads.map((t) => t.threadName).join(', ') || 'none'})\n` +
            `  - Errors: ${forumResult.errors.length}`
        );
      } catch (error) {
        console.error('[Scheduler] Failed to execute forum cleanup batch:', error);
      }
    }
  );

  const nextRun = job.nextRun();
  console.log(
    `[Scheduler] Cron scheduled. Next run at: ${nextRun ? nextRun.toISOString() : 'unknown'} (${
      nextRun?.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) ?? ''
    } JST)`
  );

  return {
    nextRun: () => job.nextRun(),
    stop() {
      job.stop();
      assignmentPosting.stop();
    },
  };
}
