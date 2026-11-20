import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type Client,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import { getConfig } from '../config.js';
import { runExclusiveBatch } from '../utils/batchExecution.js';
import { calculateDiffDays, formatChannelName, getJSTParts } from '../utils/dateUtils.js';

export const BUTTON_IDS = {
  CONFIRM_DELETE: 'disposable_channel_delete_confirm',
  CANCEL_DELETE: 'disposable_channel_delete_cancel',
} as const;

const DELETE_CONFIRM_HEADING = '⚠️ **【使い捨てチャンネル削除確認】**';
export const DISPOSABLE_POSTPONE_MARKER = '⏸️ チャンネルの削除は保留されました。';
const MESSAGE_PAGE_SIZE = 100;
const JST_OFFSET_HOURS = 9;

export interface LifecycleResult {
  created: boolean;
  createdChannel: TextChannel | null;
  todayChannel: TextChannel | null;
  createdChannelName: string;
  confirmSentChannels: string[];
  deletedChannels: string[];
  skippedChannels: string[];
  errors: string[];
}

interface LifecycleOptions {
  createTopic?: string;
}

function dailyBatchKey(guildId: string): string {
  return `daily-lifecycle:${guildId}`;
}

async function hasDailyDeletionNotice(
  channel: TextChannel,
  botMember: GuildMember,
  dayStart: number,
  nextDayStart: number,
): Promise<boolean> {
  // Discord can return an empty history when the permission is missing.
  if (!channel.permissionsFor(botMember)?.has(PermissionFlagsBits.ReadMessageHistory)) {
    throw new Error('Read Message History is required to check for an existing deletion confirmation.');
  }

  let before: string | undefined;
  while (true) {
    const messages = await channel.messages.fetch({ before, limit: MESSAGE_PAGE_SIZE, cache: false });
    if (messages.some(({ author, createdTimestamp, content }) => author.id === botMember.id
      && createdTimestamp >= dayStart && createdTimestamp < nextDayStart
      && (content.startsWith(DELETE_CONFIRM_HEADING) || content.startsWith(DISPOSABLE_POSTPONE_MARKER)))) {
      return true;
    }

    const oldest = messages.last();
    if (!oldest || oldest.createdTimestamp < dayStart || messages.size < MESSAGE_PAGE_SIZE) return false;
    if (oldest.id === before) throw new Error('Discord did not advance the message history cursor.');
    before = oldest.id;
  }
}

async function deleteExpiredChannel(
  guild: Guild,
  channel: TextChannel,
  categoryId: string,
  referenceDate: Date,
  result: LifecycleResult,
): Promise<void> {
  const { id, name } = channel;
  const skip = (reason: string) => {
    console.warn(`[ChannelManager] Skipping automatic deletion of #${name} (${id}): ${reason}`);
    result.skippedChannels.push(name);
  };

  try {
    // A forced fetch with caching enabled updates any existing discord.js channel instance.
    const current = await guild.channels.fetch(id, { force: true });
    if (!current) {
      skip('the current channel could not be found');
      return;
    }
    if (current.type !== ChannelType.GuildText || current.parentId !== categoryId) {
      skip(`the channel type (${ChannelType[current.type]}) or category (${current.parentId ?? 'none'}) is outside the managed criteria`);
      return;
    }
    const age = current.createdAt ? calculateDiffDays(current.name, referenceDate, current.createdAt) : null;
    if (age === null || age < 7) {
      skip(`the current name #${current.name} and creation date do not identify a channel at least seven days old`);
      return;
    }

    console.log(`[ChannelManager] Channel #${current.name} is ${age} days old (>= 7). Deleting...`);
    await current.delete(`作成から7日経過による自動削除 (${age}日経過)`);
    result.deletedChannels.push(current.name);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === RESTJSONErrorCodes.UnknownChannel) {
      skip('the channel was already deleted');
      return;
    }

    const reason = code === RESTJSONErrorCodes.MissingPermissions
      ? 'the bot lacks permission to verify or delete the channel'
      : error instanceof Error ? error.message : String(error);
    skip(reason);
    result.errors.push(`Automatic deletion failed for #${name} (${id}): ${reason}`);
  }
}

/**
 * Executes the daily lifecycle for disposable channels in the target category:
 * 1. Creates today's channel (使い捨て会話_MM月DD日) if it doesn't exist.
 * 2. Checks past channels:
 *    - 1-6 days old: Sends confirmation prompt with Red Delete and Gray Postpone buttons.
 *    - 7+ days old: Automatically deletes the channel.
 */
export async function runDailyLifecycle(
  client: Client,
  referenceDate: Date = new Date(),
  options: LifecycleOptions = {}
): Promise<LifecycleResult> {
  const config = getConfig();
  return runExclusiveBatch(dailyBatchKey(config.GUILD_ID), async () => {
    const guild = await client.guilds.fetch(config.GUILD_ID);

    if (!guild) {
      throw new Error(`Guild with ID ${config.GUILD_ID} not found.`);
    }

    return executeDailyLifecycle(guild, config.CATEGORY_ID, referenceDate, options);
  });
}

/**
 * Core lifecycle runner decoupled from config for testability and flexibility.
 */
export async function runLifecycleForGuild(
  guild: Guild,
  categoryId: string,
  referenceDate: Date = new Date(),
  options: LifecycleOptions = {}
): Promise<LifecycleResult> {
  return runExclusiveBatch(dailyBatchKey(guild.id), () =>
    executeDailyLifecycle(guild, categoryId, referenceDate, options));
}

async function executeDailyLifecycle(
  guild: Guild,
  categoryId: string,
  referenceDate: Date,
  options: LifecycleOptions
): Promise<LifecycleResult> {
  const result: LifecycleResult = {
    created: false,
    createdChannel: null,
    todayChannel: null,
    createdChannelName: '',
    confirmSentChannels: [],
    deletedChannels: [],
    skippedChannels: [],
    errors: [],
  };

  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error(
      `Bot lacks 'Manage Channels' permission in guild '${guild.name}' (${guild.id}).`
    );
  }

  // Fetch all channels in guild to ensure cache is up-to-date
  const allChannels = await guild.channels.fetch();
  const category = allChannels.get(categoryId);

  if (!category || category.type !== ChannelType.GuildCategory) {
    throw new Error(`Target category '${categoryId}' not found or is not a category channel.`);
  }

  const categoryPerms = category.permissionsFor?.(botMember);
  if (categoryPerms && !categoryPerms.has(PermissionFlagsBits.ManageChannels)) {
    throw new Error(
      `Bot lacks 'Manage Channels' permission in category '${category.name}' (${categoryId}).`
    );
  }

  const todayChannelName = formatChannelName(referenceDate);
  result.createdChannelName = todayChannelName;

  // Filter text channels under the target category
  const targetChannels = Array.from(allChannels.values())
    .filter((channel): channel is TextChannel =>
      channel !== null && channel.parentId === categoryId && channel.type === ChannelType.GuildText)
    .map((channel) => ({
      channel,
      diffDays: calculateDiffDays(channel.name, referenceDate, channel.createdAt),
    }));

  // 1. Create today's channel if it doesn't exist
  const currentChannels = targetChannels.filter(({ diffDays }) => diffDays === 0);
  const preferredChannel = options.createTopic === undefined
    ? undefined
    : currentChannels.find(({ channel }) => channel.topic === options.createTopic);
  const existingToday = preferredChannel ?? currentChannels[0];
  if (!existingToday) {
    try {
      const newChannel = await guild.channels.create({
        name: todayChannelName,
        type: ChannelType.GuildText,
        parent: categoryId,
        reason: '毎日0:00の使い捨て会話チャンネル自動生成',
        ...(options.createTopic === undefined ? {} : { topic: options.createTopic }),
      });
      result.created = true;
      result.createdChannel = newChannel;
      result.todayChannel = newChannel;

      try {
        await newChannel.send({
          content:
            `📢 **本日の使い捨て会話チャンネルです** (#${todayChannelName})\n` +
            `このチャンネルは毎日 00:00 (JST) に自動生成されます。\n` +
            `作成から1〜6日経過時に削除確認メッセージが送信され、**7日経過で自動削除**されます。\n` +
            `自由にご利用ください！`,
          flags: [MessageFlags.SuppressNotifications],
        });
      } catch (msgErr: any) {
        console.warn(
          `[ChannelManager] Failed to send welcome message to #${todayChannelName}: ${msgErr.message}`
        );
      }
      console.log(`[ChannelManager] Created today channel: #${todayChannelName}`);
    } catch (err: any) {
      const errMsg = `Failed to create #${todayChannelName}: ${err.message}`;
      console.error(`[ChannelManager] ${errMsg}`, err);
      result.errors.push(errMsg);
    }
  } else {
    result.todayChannel = existingToday.channel;
    console.log(`[ChannelManager] Today channel #${existingToday.channel.name} already exists, skipping creation.`);
  }

  const { year, month, day } = getJSTParts(referenceDate);
  const dayStart = Date.UTC(year, month - 1, day, -JST_OFFSET_HOURS);
  const nextDayStart = Date.UTC(year, month - 1, day + 1, -JST_OFFSET_HOURS);

  // 2. Iterate through channels in category and manage past disposable channels
  for (const { channel, diffDays } of targetChannels) {
    // Skip channels not matching naming scheme or created today / future
    if (diffDays === null || diffDays <= 0) {
      result.skippedChannels.push(channel.name);
      continue;
    }

    // 7+ days old: Automatic deletion
    if (diffDays >= 7) {
      await deleteExpiredChannel(guild, channel, categoryId, referenceDate, result);
      continue;
    }

    // 1-6 days old: Send deletion confirmation message
    if (diffDays >= 1 && diffDays < 7) {
      try {
        if (await hasDailyDeletionNotice(channel, botMember, dayStart, nextDayStart)) {
          result.skippedChannels.push(channel.name);
          continue;
        }

        const confirmButton = new ButtonBuilder()
          .setCustomId(BUTTON_IDS.CONFIRM_DELETE)
          .setLabel('🗑️ チャンネルを削除する')
          .setStyle(ButtonStyle.Danger);

        const cancelButton = new ButtonBuilder()
          .setCustomId(BUTTON_IDS.CANCEL_DELETE)
          .setLabel('保留する')
          .setStyle(ButtonStyle.Secondary);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          confirmButton,
          cancelButton
        );

        await channel.send({
          content:
            `${DELETE_CONFIRM_HEADING}\n` +
            `このチャンネル（#${channel.name}）は作成から **${diffDays}日** が経過しています。\n` +
            `手動で削除したい場合は下のボタンを押してください。\n` +
            `*(※作成から7日経過すると自動削除されます。実行には「チャンネルの管理」権限が必要です)*`,
          components: [row],
          flags: [MessageFlags.SuppressNotifications],
        });

        console.log(
          `[ChannelManager] Sent deletion confirmation to #${channel.name} (${diffDays} days old)`
        );
        result.confirmSentChannels.push(channel.name);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const errMsg = `Failed to check or send a confirmation message for #${channel.name}: ${reason}`;
        console.error(`[ChannelManager] ${errMsg}`, error);
        result.errors.push(errMsg);
      }
    }
  }

  return result;
}
