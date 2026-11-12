import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Guild,
  NewsChannel,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import { getConfig } from '../config.js';
import { calculateDiffDays, formatChannelName } from '../utils/dateUtils.js';

export const BUTTON_IDS = {
  CONFIRM_DELETE: 'disposable_channel_delete_confirm',
  CANCEL_DELETE: 'disposable_channel_delete_cancel',
} as const;

export interface LifecycleResult {
  created: boolean;
  createdChannelName: string;
  confirmSentChannels: string[];
  deletedChannels: string[];
  skippedChannels: string[];
  errors: string[];
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
  referenceDate: Date = new Date()
): Promise<LifecycleResult> {
  const config = getConfig();
  const guild = await client.guilds.fetch(config.GUILD_ID);

  if (!guild) {
    throw new Error(`Guild with ID ${config.GUILD_ID} not found.`);
  }

  return runLifecycleForGuild(guild, config.CATEGORY_ID, referenceDate);
}

/**
 * Core lifecycle runner decoupled from config for testability and flexibility.
 */
export async function runLifecycleForGuild(
  guild: Guild,
  categoryId: string,
  referenceDate: Date = new Date()
): Promise<LifecycleResult> {
  const result: LifecycleResult = {
    created: false,
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
  const allChannelsList = Array.from(allChannels.values());
  const targetChannels = allChannelsList.filter(
    (ch): ch is TextChannel =>
      ch !== null &&
      ch.parentId === categoryId &&
      ch.type === ChannelType.GuildText
  );

  // 1. Create today's channel if it doesn't exist
  const existingToday = targetChannels.find((ch) => ch.name === todayChannelName);
  if (!existingToday) {
    try {
      const newChannel = await guild.channels.create({
        name: todayChannelName,
        type: ChannelType.GuildText,
        parent: categoryId,
        reason: '毎日0:00の使い捨て会話チャンネル自動生成',
      });
      result.created = true;

      try {
        await newChannel.send({
          content:
            `📢 **本日の使い捨て会話チャンネルです** (#${todayChannelName})\n` +
            `このチャンネルは毎日 00:00 (JST) に自動生成されます。\n` +
            `作成から1〜6日経過時に削除確認メッセージが送信され、**7日経過で自動削除**されます。\n` +
            `自由にご利用ください！`,
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
    console.log(`[ChannelManager] Today channel #${todayChannelName} already exists, skipping creation.`);
  }

  // 2. Iterate through channels in category and manage past disposable channels
  for (const channel of targetChannels) {
    const diffDays = calculateDiffDays(channel.name, referenceDate, channel.createdAt);

    // Skip channels not matching naming scheme or created today / future
    if (diffDays === null || diffDays <= 0) {
      result.skippedChannels.push(channel.name);
      continue;
    }

    // 7+ days old: Automatic deletion
    if (diffDays >= 7) {
      try {
        console.log(
          `[ChannelManager] Channel #${channel.name} is ${diffDays} days old (>= 7). Deleting...`
        );
        await channel.delete(`作成から7日経過による自動削除 (${diffDays}日経過)`);
        result.deletedChannels.push(channel.name);
      } catch (err: any) {
        const errMsg = `Failed to delete #${channel.name}: ${err.message}`;
        console.error(`[ChannelManager] ${errMsg}`, err);
        result.errors.push(errMsg);
      }
      continue;
    }

    // 1-6 days old: Send deletion confirmation message
    if (diffDays >= 1 && diffDays < 7) {
      try {
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
            `⚠️ **【使い捨てチャンネル削除確認】**\n` +
            `このチャンネル（#${channel.name}）は作成から **${diffDays}日** が経過しています。\n` +
            `手動で削除したい場合は下のボタンを押してください。\n` +
            `*(※作成から7日経過すると自動削除されます。実行には「チャンネルの管理」権限が必要です)*`,
          components: [row],
        });

        console.log(
          `[ChannelManager] Sent deletion confirmation to #${channel.name} (${diffDays} days old)`
        );
        result.confirmSentChannels.push(channel.name);
      } catch (err: any) {
        const errMsg = `Failed to send confirmation message to #${channel.name}: ${err.message}`;
        console.error(`[ChannelManager] ${errMsg}`, err);
        result.errors.push(errMsg);
      }
    }
  }

  return result;
}
