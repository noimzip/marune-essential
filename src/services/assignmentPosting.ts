import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type Client,
  type GuildBasedChannel,
  type Snowflake,
  type TextChannel,
} from 'discord.js';
import { getConfig } from '../config.js';
import { calculateDiffDays, formatJSTDateSlash } from '../utils/dateUtils.js';
import { ASSIGNMENT_MESSAGE_HEADING, formatAssignmentMessage } from './assignmentMessages.js';
import { getUpcomingAssignments, WEBCLASS_RETRY_INTERVAL_MS } from './webClass.js';

export function pendingAssignmentTopic(date: Date): string {
  return 'WebClass 課題一覧（' + formatJSTDateSlash(date) + '・投稿待ち）';
}

function publishedAssignmentTopic(date: Date): string {
  return 'WebClass 課題一覧（' + formatJSTDateSlash(date) + '・投稿済み）';
}

function isPendingAssignmentChannel(
  channel: GuildBasedChannel | null,
  date: Date,
  categoryId: string,
): channel is TextChannel {
  return channel !== null && channel.type === ChannelType.GuildText
    && channel.parentId === categoryId
    && channel.topic === pendingAssignmentTopic(date)
    && formatJSTDateSlash(channel.createdAt) === formatJSTDateSlash(date)
    && calculateDiffDays(channel.name, date, channel.createdAt) === 0;
}

async function hasAssignmentPost(channel: TextChannel, botId: Snowflake): Promise<boolean> {
  // The API can return an empty list rather than an error when the history permission is absent.
  if (!channel.permissionsFor(botId)?.has(PermissionFlagsBits.ReadMessageHistory)) {
    throw new Error('Read Message History is required to resume a pending assignment post.');
  }

  const limit = 100;
  let before: Snowflake | undefined;
  while (true) {
    const messages = await channel.messages.fetch({ before, limit, cache: false });
    if (messages.some(({ author, content }) => author.id === botId
      && content.startsWith(ASSIGNMENT_MESSAGE_HEADING))) {
      return true;
    }
    if (messages.size < limit) return false;
    const oldest = messages.lastKey();
    if (!oldest || oldest === before) throw new Error('Discord did not advance the message history cursor.');
    before = oldest;
  }
}

export function startAssignmentPosting(client: Client) {
  let stopped = false;
  let retry: { day: string; timer: ReturnType<typeof setTimeout> } | undefined;
  const posting = new Map<Snowflake, Promise<void>>();

  function isCurrentDay(date: Date): boolean {
    return !stopped && formatJSTDateSlash(date) === formatJSTDateSlash(new Date());
  }

  async function findPendingChannel(date: Date, guildId: string, categoryId: string) {
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    for (const channel of channels.values()) {
      if (isPendingAssignmentChannel(channel, date, categoryId)) return channel;
    }
    return null;
  }

  async function publish(channel: TextChannel, date: Date, categoryId: string, freshlyCreated: boolean) {
    const botId = client.user?.id;
    if (!botId) throw new Error('Discord client user is unavailable.');

    const delivered = !freshlyCreated && await hasAssignmentPost(channel, botId);
    if (!isCurrentDay(date)) return;
    if (!delivered) {
      const assignments = await getUpcomingAssignments(new Date(), freshlyCreated);
      if (!isCurrentDay(date)) return;

      const current = await channel.fetch(true);
      if (!isCurrentDay(date) || !isPendingAssignmentChannel(current, date, categoryId)) return;
      await current.send({
        ...formatAssignmentMessage(assignments),
        flags: [MessageFlags.SuppressNotifications],
        nonce: 'hw:' + current.id,
        enforceNonce: true,
      });
    }

    if (!isCurrentDay(date)) return;
    const current = await channel.fetch(true);
    if (isCurrentDay(date) && isPendingAssignmentChannel(current, date, categoryId)) {
      await current.setTopic(publishedAssignmentTopic(date));
    }
  }

  function scheduleRetry(date: Date) {
    if (!isCurrentDay(date)) return;
    const day = formatJSTDateSlash(date);
    if (retry?.day === day) return;
    if (retry) clearTimeout(retry.timer);
    const timer = setTimeout(() => {
      retry = undefined;
      void post(date);
    }, WEBCLASS_RETRY_INTERVAL_MS);
    timer.unref();
    retry = { day, timer };
  }

  async function post(date: Date, candidate?: TextChannel | null, freshlyCreated = false): Promise<void> {
    if (!isCurrentDay(date)) return;
    try {
      const config = getConfig();
      const channel = candidate === undefined
        ? await findPendingChannel(date, config.GUILD_ID, config.CATEGORY_ID)
        : candidate;
      if (!isCurrentDay(date) || !isPendingAssignmentChannel(channel, date, config.CATEGORY_ID)) return;

      let pending = posting.get(channel.id);
      if (!pending) {
        pending = publish(channel, date, config.CATEGORY_ID, freshlyCreated)
          .finally(() => posting.delete(channel.id));
        posting.set(channel.id, pending);
      }
      await pending;
    } catch (error) {
      const reason = error instanceof Error ? error.message : '不明なエラー';
      console.error('[Scheduler] WebClass 課題一覧の投稿に失敗しました。', reason);
      scheduleRetry(date);
    }
  }

  return {
    post,
    stop() {
      stopped = true;
      if (retry) clearTimeout(retry.timer);
    },
  };
}
