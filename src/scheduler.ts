import { Cron } from 'croner';
import type { Client } from 'discord.js';
import { getConfig } from './config.js';
import { runDailyLifecycle } from './services/channelManager.js';
import { runForumCleanup } from './services/forumManager.js';
import { pendingAssignmentTopic, startAssignmentPosting } from './services/assignmentPosting.js';
import { formatJSTDateSlash } from './utils/dateUtils.js';

const CHANNEL_RETRY_INTERVAL_MS = 5 * 60 * 1000;

export interface DailyScheduler {
  nextRun(): Date | null;
  stop(): void;
}

export function startDailyScheduler(client: Client): DailyScheduler {
  console.log('[Scheduler] Initializing daily lifecycle cron job at 00:00:00 JST...');

  const assignmentPosting = getConfig().WEBCLASS_ENABLED ? startAssignmentPosting(client) : null;
  let channelRetry: ReturnType<typeof setTimeout> | undefined;
  let channelRecovery: Promise<void> | undefined;
  let stopped = false;

  function isCurrentDay(date: Date): boolean {
    return !stopped && formatJSTDateSlash(date) === formatJSTDateSlash(new Date());
  }

  function clearChannelRetry(): void {
    if (channelRetry) clearTimeout(channelRetry);
    channelRetry = undefined;
  }

  function scheduleChannelRetry(date: Date): void {
    if (!isCurrentDay(date) || channelRetry) return;
    channelRetry = setTimeout(() => {
      channelRetry = undefined;
      recoverTodayChannel(date);
    }, CHANNEL_RETRY_INTERVAL_MS);
    channelRetry.unref();
  }

  async function runChannelBatch(referenceDate: Date, createOnly: boolean): Promise<void> {
    try {
      const result = await runDailyLifecycle(client, referenceDate, {
        createOnly,
        canCreate: () => isCurrentDay(referenceDate),
        createTopic: assignmentPosting ? pendingAssignmentTopic(referenceDate) : undefined,
      });
      if (result.todayChannel) {
        if (isCurrentDay(referenceDate)) {
          clearChannelRetry();
          void assignmentPosting?.post(referenceDate, result.todayChannel, result.created);
        }
      } else {
        scheduleChannelRetry(referenceDate);
      }
      if (!createOnly) {
        const todayStatus = result.created
          ? `Created #${result.createdChannelName}`
          : result.todayChannel ? 'Already exists' : 'Unavailable';
        console.log(
          `[Scheduler] Disposable channel batch finished.\n` +
            `  - Today's channel: ${todayStatus}\n` +
            `  - Confirm sent: ${result.confirmSentChannels.length} (${result.confirmSentChannels.join(', ') || 'none'})\n` +
            `  - Deleted: ${result.deletedChannels.length} (${result.deletedChannels.join(', ') || 'none'})\n` +
            `  - Errors: ${result.errors.length}`
        );
      }
    } catch (error) {
      console.error('[Scheduler] Failed to execute daily channel lifecycle:', error);
      scheduleChannelRetry(referenceDate);
    }
  }

  function recoverTodayChannel(date: Date): void {
    if (!isCurrentDay(date)) return;
    channelRecovery = runChannelBatch(date, true).finally(() => { channelRecovery = undefined; });
  }

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

      clearChannelRetry();
      await channelRecovery;
      if (stopped) return;
      await runChannelBatch(referenceDate, false);
      if (stopped) return;

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

  recoverTodayChannel(new Date());

  return {
    nextRun: () => job.nextRun(),
    stop() {
      stopped = true;
      job.stop();
      clearChannelRetry();
      assignmentPosting?.stop();
    },
  };
}
