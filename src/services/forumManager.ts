import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelFlags,
  ChannelType,
  Client,
  Collection,
  ForumChannel,
  Guild,
  Message,
  MessageFlags,
  PermissionFlagsBits,
  ThreadChannel,
} from 'discord.js';
import { getConfig, parseExcludedForumIds } from '../config.js';
import { runExclusiveBatch } from '../utils/batchExecution.js';
import { calculateElapsedDays, formatJSTDateSlash } from '../utils/dateUtils.js';
import { withTemporaryThreadUnarchive } from './forumThreadArchive.js';

export const FORUM_BUTTON_IDS = {
  CONFIRM_DELETE: 'forum_thread_delete_confirm',
  CANCEL_KEEP: 'forum_thread_delete_keep',
} as const;

export const FORUM_CONFIRM_MARKER =
  '⚠️ **【定期確認】このフォーラムトピックを削除しますか？**';
export const FORUM_KEEP_MARKER = '📌 削除が見送られました';

export interface ForumThreadTarget {
  forumId: string;
  forumName: string;
  threadId: string;
  threadName: string;
  lastPostDate: Date;
  lastPostDateStr: string;
  elapsedDays: number;
  alreadyConfirmed: boolean;
  archived: boolean;
}

export interface ForumCleanupResult {
  inspectedForumCount: number;
  inspectedThreadCount: number;
  skippedPinnedCount: number;
  skippedAlreadyConfirmedCount: number;
  targets: ForumThreadTarget[];
  confirmSentThreads: ForumThreadTarget[];
  errors: string[];
  dryRun: boolean;
  thresholdDays: number;
}

export interface ForumCleanupOptions {
  days?: number;
  dryRun?: boolean;
  excludedForumIds?: string[];
  referenceDate?: Date;
  actionDelayMs?: number;
}

const DEFAULT_ACTION_DELAY_MS = 1000;
const MESSAGE_FETCH_BATCH_SIZE = 20;
const MAX_MESSAGE_FETCH_PAGES = 3;

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Classifies whether a message was posted by this bot as part of forum cleanup confirmation/keep flow.
 */
export function classifyForumBotMessage(
  msg: Pick<Message, 'author' | 'content' | 'components'>,
  botUserId?: string
): 'confirm' | 'keep' | null {
  const isFromThisBot = botUserId
    ? msg.author?.id === botUserId
    : Boolean(msg.author?.bot);

  if (!isFromThisBot) {
    return null;
  }

  const content = msg.content ?? '';
  if (content.startsWith(FORUM_KEEP_MARKER)) {
    return 'keep';
  }

  if (content.startsWith(FORUM_CONFIRM_MARKER)) {
    return 'confirm';
  }

  const hasForumButton = (msg.components ?? []).some((row: any) =>
    (row.components ?? []).some((comp: any) => {
      const id = comp.customId ?? comp.data?.custom_id;
      return (
        id === FORUM_BUTTON_IDS.CONFIRM_DELETE ||
        id === FORUM_BUTTON_IDS.CANCEL_KEEP
      );
    })
  );

  return hasForumButton ? 'confirm' : null;
}

/**
 * Collects the available active and archived threads even if part of the listing fails.
 */
async function collectForumThreads(
  forum: ForumChannel,
  preFetchedActive?: ThreadChannel[]
): Promise<{ threads: ThreadChannel[]; errors: string[] }> {
  const threadMap = new Map<string, ThreadChannel>();
  const errors: string[] = [];

  function recordFetchFailure(part: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `Failed to fetch ${part} in #${forum.name} (${forum.id}): ${detail}`;
    errors.push(message);
    console.error(`[ForumManager] ${message}`, error);
  }

  if (preFetchedActive) {
    for (const thread of preFetchedActive) {
      threadMap.set(thread.id, thread);
    }
  } else if (typeof forum.threads?.fetchActive === 'function') {
    try {
      const activeResult = await forum.threads.fetchActive();
      for (const thread of activeResult.threads.values()) {
        threadMap.set(thread.id, thread);
      }
    } catch (error) {
      recordFetchFailure('active threads', error);
    }
  }

  if (typeof forum.threads?.fetchArchived === 'function') {
    let before: Date | undefined;
    let page = 1;
    try {
      while (true) {
        const archivedResult = await forum.threads.fetchArchived({
          type: 'public',
          limit: 100,
          ...(before ? { before } : {}),
        });

        const batch = Array.from(archivedResult.threads.values());
        for (const thread of batch) {
          threadMap.set(thread.id, thread);
        }
        if (!archivedResult.hasMore) break;

        const nextCursor = batch.at(-1)?.archivedAt;
        if (!nextCursor || !Number.isFinite(nextCursor.getTime()) || (before && nextCursor >= before)) {
          throw new Error('Discord did not provide an earlier archive timestamp for the next page.');
        }

        before = nextCursor;
        page++;
      }
    } catch (error) {
      recordFetchFailure(`archived threads (page ${page})`, error);
    }
  }

  return { threads: Array.from(threadMap.values()), errors };
}

interface ThreadActivityInspection {
  lastPostDate: Date;
  alreadyConfirmed: boolean;
}

/**
 * Inspects thread messages to find the latest non-cleanup post date and whether a confirmation/keep is already active.
 */
async function inspectThreadActivity(
  thread: ThreadChannel,
  botUserId: string | undefined,
  thresholdDays: number,
  referenceDate: Date
): Promise<ThreadActivityInspection> {
  let latestBotCleanup: { kind: 'confirm' | 'keep'; actedAt: Date } | null = null;
  let lastHumanPostDate: Date | null = null;
  let beforeId: string | undefined;

  if (typeof thread.messages?.fetch === 'function') {
    for (let page = 0; page < MAX_MESSAGE_FETCH_PAGES; page++) {
      const fetched: Collection<string, Message> = await thread.messages.fetch({
        limit: MESSAGE_FETCH_BATCH_SIZE,
        ...(beforeId ? { before: beforeId } : {}),
      });

      const sorted = Array.from(fetched.values()).sort(
        (a, b) => b.createdTimestamp - a.createdTimestamp
      );

      if (sorted.length === 0) {
        break;
      }

      for (const msg of sorted) {
        const kind = classifyForumBotMessage(msg, botUserId);
        if (kind !== null) {
          if (!latestBotCleanup) {
            latestBotCleanup = {
              kind,
              actedAt: kind === 'keep' ? msg.editedAt ?? msg.createdAt : msg.createdAt,
            };
          }
          continue;
        }

        lastHumanPostDate = msg.createdAt;
        break;
      }

      if (lastHumanPostDate || sorted.length < MESSAGE_FETCH_BATCH_SIZE) {
        break;
      }

      const oldestId = sorted[sorted.length - 1].id;
      if (!oldestId || oldestId === beforeId) {
        break;
      }
      beforeId = oldestId;
    }
  }

  const lastPostDate = lastHumanPostDate ?? thread.createdAt ?? referenceDate;

  let alreadyConfirmed = false;
  if (latestBotCleanup) {
    if (latestBotCleanup.kind === 'confirm') {
      alreadyConfirmed = true;
    } else if (latestBotCleanup.kind === 'keep') {
      const keepGraceDays = Math.max(1, thresholdDays);
      const keepElapsed = calculateElapsedDays(latestBotCleanup.actedAt, referenceDate);
      if (keepElapsed < keepGraceDays) {
        alreadyConfirmed = true;
      }
    }
  }

  return { lastPostDate, alreadyConfirmed };
}

/**
 * Sends the deletion confirmation prompt with Approve & Keep buttons to the target thread.
 */
async function sendConfirmationToThread(
  thread: ThreadChannel,
  lastPostDate: Date,
  elapsedDays: number,
  thresholdDays: number
): Promise<void> {
  const confirmButton = new ButtonBuilder()
    .setCustomId(FORUM_BUTTON_IDS.CONFIRM_DELETE)
    .setLabel('🗑️ 承認して削除する')
    .setStyle(ButtonStyle.Danger);

  const keepButton = new ButtonBuilder()
    .setCustomId(FORUM_BUTTON_IDS.CANCEL_KEEP)
    .setLabel('📌 残しておく（確認を閉じる）')
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    confirmButton,
    keepButton
  );

  const lastPostDateStr = formatJSTDateSlash(lastPostDate);
  await withTemporaryThreadUnarchive(thread, {
    openReason: '削除確認メッセージ送信のためアーカイブ一時解除',
    closeReason: '削除確認メッセージ送信後の自動クローズ',
    afterSuccess: 'archive',
  }, () => thread.send({
    content:
      `${FORUM_CONFIRM_MARKER}\n` +
      `最後の投稿から **${thresholdDays}日以上**（最終投稿: \`${lastPostDateStr}\`・\`${elapsedDays}日経過\`）が経過しています。\n` +
      `不要なトピックであれば、「チャンネルの管理」権限を持つメンバーが下のボタンを押して削除を承認してください。`,
    components: [row],
    flags: [MessageFlags.SuppressNotifications],
  }));
}

/**
 * Config-backed entry point for scheduled runs and slash commands.
 */
export async function runForumCleanup(
  client: Client,
  options: ForumCleanupOptions = {}
): Promise<ForumCleanupResult> {
  const config = getConfig();
  return runExclusiveBatch(`forum-cleanup:${config.GUILD_ID}`, async () => {
    const guild = await client.guilds.fetch(config.GUILD_ID);
    if (!guild) {
      throw new Error(`Guild with ID ${config.GUILD_ID} not found.`);
    }

    return runForumCleanupForGuild(guild, {
      ...options,
      days: options.days ?? config.FORUM_INACTIVE_DAYS,
      excludedForumIds: options.excludedForumIds ?? parseExcludedForumIds(config.EXCLUDED_FORUM_IDS),
    });
  });
}

/**
 * Config-independent core runner for forum thread cleanup (unit-testable).
 */
export async function runForumCleanupForGuild(
  guild: Guild,
  options: ForumCleanupOptions = {}
): Promise<ForumCleanupResult> {
  const thresholdDays = options.days ?? 21;
  const dryRun = options.dryRun ?? false;
  const excludedSet = new Set(options.excludedForumIds ?? []);
  const referenceDate = options.referenceDate ?? new Date();
  const actionDelayMs = options.actionDelayMs ?? DEFAULT_ACTION_DELAY_MS;

  const result: ForumCleanupResult = {
    inspectedForumCount: 0,
    inspectedThreadCount: 0,
    skippedPinnedCount: 0,
    skippedAlreadyConfirmedCount: 0,
    targets: [],
    confirmSentThreads: [],
    errors: [],
    dryRun,
    thresholdDays,
  };

  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  const botUserId = botMember?.id ?? guild.client?.user?.id;

  const allChannels = await guild.channels.fetch();
  const forumChannels = Array.from(allChannels.values()).filter(
    (ch): ch is ForumChannel =>
      ch !== null &&
      ch.type === ChannelType.GuildForum &&
      !excludedSet.has(ch.id)
  );

  // Fetch all guild active threads once to avoid redundant API calls per forum
  let activeByParent: Map<string, ThreadChannel[]> | undefined;
  if (forumChannels.length > 0 && typeof guild.channels.fetchActiveThreads === 'function') {
    activeByParent = new Map<string, ThreadChannel[]>();
    try {
      const activeFetched = await guild.channels.fetchActiveThreads();
      for (const thread of activeFetched.threads.values()) {
        if (!thread.parentId) continue;
        const list = activeByParent.get(thread.parentId) ?? [];
        list.push(thread);
        activeByParent.set(thread.parentId, list);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      result.errors.push(`Failed to fetch active threads in guild ${guild.id}: ${detail}`);
      console.error('[ForumManager] Failed to fetch active threads. Continuing with archived threads:', error);
    }
  }

  const requiredPerms = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.ReadMessageHistory,
  ];

  for (const forum of forumChannels) {
    const forumPerms = forum.permissionsFor?.(botMember);
    if (forumPerms && !requiredPerms.every((perm) => forumPerms.has(perm))) {
      const errMsg = `Bot lacks required forum permissions (ViewChannel, ManageThreads, SendMessagesInThreads, ReadMessageHistory) in #${forum.name} (${forum.id}).`;
      console.warn(`[ForumManager] ${errMsg}`);
      result.errors.push(errMsg);
      continue;
    }

    result.inspectedForumCount++;

    const active = activeByParent ? activeByParent.get(forum.id) ?? [] : undefined;
    const { threads, errors } = await collectForumThreads(forum, active);
    result.errors.push(...errors);

    for (const thread of threads) {
      result.inspectedThreadCount++;

      // Skip pinned threads to prevent accidental deletion
      if (thread.flags?.has(ChannelFlags.Pinned)) {
        result.skippedPinnedCount++;
        continue;
      }

      try {
        const { lastPostDate, alreadyConfirmed } = await inspectThreadActivity(
          thread,
          botUserId,
          thresholdDays,
          referenceDate
        );

        const elapsedDays = calculateElapsedDays(lastPostDate, referenceDate);
        if (elapsedDays < thresholdDays) {
          continue;
        }

        const target: ForumThreadTarget = {
          forumId: forum.id,
          forumName: forum.name,
          threadId: thread.id,
          threadName: thread.name,
          lastPostDate,
          lastPostDateStr: formatJSTDateSlash(lastPostDate),
          elapsedDays,
          alreadyConfirmed,
          archived: Boolean(thread.archived),
        };

        result.targets.push(target);

        if (dryRun) {
          continue;
        }

        if (alreadyConfirmed) {
          result.skippedAlreadyConfirmedCount++;
          continue;
        }

        await sendConfirmationToThread(thread, lastPostDate, elapsedDays, thresholdDays);
        result.confirmSentThreads.push(target);
        console.log(
          `[ForumManager] Sent confirmation to forum thread #${thread.name} in #${forum.name} (${elapsedDays} days inactive)`
        );

        await sleep(actionDelayMs);
      } catch (threadErr: any) {
        const errMsg = `Failed to process thread #${thread.name} in #${forum.name}: ${threadErr.message ?? threadErr}`;
        console.error(`[ForumManager] ${errMsg}`, threadErr);
        result.errors.push(errMsg);
      }
    }
  }

  return result;
}
