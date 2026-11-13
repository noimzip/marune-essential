import {
  ButtonInteraction,
  ChannelType,
  Interaction,
  PermissionFlagsBits,
  TextChannel,
  ThreadChannel,
} from 'discord.js';
import { BUTTON_IDS } from '../services/channelManager.js';
import {
  FORUM_BUTTON_IDS,
  FORUM_KEEP_MARKER,
} from '../services/forumManager.js';
import { handleDailyBatchRun } from '../commands/dailyBatchRun.js';
import { handleTestForumCleanup } from '../commands/testForumCleanup.js';

const ALL_MANAGED_BUTTON_IDS = new Set<string>([
  BUTTON_IDS.CONFIRM_DELETE,
  BUTTON_IDS.CANCEL_DELETE,
  FORUM_BUTTON_IDS.CONFIRM_DELETE,
  FORUM_BUTTON_IDS.CANCEL_KEEP,
]);

/**
 * Resolves the target channel/thread from interaction cache or falls back to Discord API fetch.
 */
async function resolveInteractionChannel(
  interaction: ButtonInteraction,
  logPrefix: string
): Promise<any | null> {
  let channel: any = interaction.channel;
  if (!channel && interaction.channelId) {
    try {
      channel =
        (await interaction.guild?.channels.fetch(interaction.channelId)) ??
        (await interaction.client.channels.fetch(interaction.channelId));
    } catch (fetchErr) {
      console.error(`${logPrefix} Failed to fetch channel:`, fetchErr);
    }
  }
  return channel ?? null;
}

/**
 * Maps Discord REST deletion errors (50013 / 10003) into user-facing ephemeral feedback.
 */
async function replyDeleteError(
  interaction: ButtonInteraction,
  err: any,
  logPrefix: string,
  targetLabel: string
): Promise<void> {
  console.error(`${logPrefix} Error deleting ${targetLabel}:`, err);
  const errorMessage =
    err?.code === 50013
      ? `Botにこの${targetLabel}を削除する権限がありません。`
      : err?.code === 10003
      ? `この${targetLabel}は既に削除されているか、見つかりません。`
      : `${targetLabel}の削除に失敗しました: ${err?.message ?? err}`;

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({
      content: `⚠️ ${errorMessage}`,
      ephemeral: true,
    });
  } else {
    await interaction.reply({
      content: `⚠️ ${errorMessage}`,
      ephemeral: true,
    });
  }
}

async function handleDisposableChannelButton(
  interaction: ButtonInteraction
): Promise<void> {
  const { customId } = interaction;

  if (customId === BUTTON_IDS.CONFIRM_DELETE) {
    const channel = await resolveInteractionChannel(interaction, '[Button:Confirm]');

    if (!channel || typeof channel.delete !== 'function') {
      await interaction.reply({
        content: '⚠️ チャンネル情報を取得できませんでした。',
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: '🗑️ チャンネルを削除しています...',
      ephemeral: true,
    });

    const executorTag = interaction.user.tag ?? interaction.user.username;
    try {
      await (channel as TextChannel).delete(
        `ユーザー承認による使い捨てチャンネル手動削除 (実行者: ${executorTag})`
      );
    } catch (err: any) {
      await replyDeleteError(interaction, err, '[Button:Confirm]', 'チャンネル');
    }
    return;
  }

  if (customId === BUTTON_IDS.CANCEL_DELETE) {
    try {
      await interaction.update({
        content: `⏸️ チャンネルの削除は保留されました。(担当者: <@${interaction.user.id}>)`,
        components: [],
      });
    } catch (updateErr: any) {
      console.error('[Button:Cancel] Failed to update message:', updateErr);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: `⚠️ 保留処理に失敗しました: ${updateErr.message ?? updateErr}`,
          ephemeral: true,
        });
      }
    }
  }
}

async function handleForumThreadButton(
  interaction: ButtonInteraction
): Promise<void> {
  const { customId } = interaction;
  const channel = await resolveInteractionChannel(interaction, '[ForumButton]');

  const isThread =
    typeof channel?.isThread === 'function'
      ? channel.isThread()
      : channel?.type === ChannelType.PublicThread ||
        channel?.type === ChannelType.PrivateThread;

  const isUnderNonForumParent =
    channel?.parent && channel.parent.type !== ChannelType.GuildForum;

  if (!channel || !isThread || isUnderNonForumParent) {
    await interaction.reply({
      content: '⚠️ この操作はフォーラムチャンネル配下のトピック内でのみ有効です。',
      ephemeral: true,
    });
    return;
  }

  if (customId === FORUM_BUTTON_IDS.CONFIRM_DELETE) {
    if (typeof channel.delete !== 'function') {
      await interaction.reply({
        content: '⚠️ トピック情報を取得できませんでした。',
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: '✅ 削除が承認されました。このトピックを削除します。',
      ephemeral: true,
    });

    const executorTag = interaction.user.tag ?? interaction.user.username;
    try {
      await (channel as ThreadChannel).delete(
        `長期未更新フォーラムトピック削除承認 (承認者: ${executorTag})`
      );
    } catch (err: any) {
      await replyDeleteError(interaction, err, '[ForumButton:Confirm]', 'トピック');
    }
    return;
  }

  if (customId === FORUM_BUTTON_IDS.CANCEL_KEEP) {
    try {
      await interaction.update({
        content: `${FORUM_KEEP_MARKER}（承認者: <@${interaction.user.id}>）`,
        components: [],
      });
    } catch (updateErr: any) {
      console.error('[ForumButton:Keep] Failed to update message:', updateErr);
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({
          content: `⚠️ 見送り処理に失敗しました: ${updateErr.message ?? updateErr}`,
          ephemeral: true,
        });
      }
    }
  }
}

export async function handleInteraction(interaction: Interaction): Promise<void> {
  try {
    // 1. Handle Slash Commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'daily-batch-run') {
        await handleDailyBatchRun(interaction);
      } else if (interaction.commandName === 'test_forum_cleanup') {
        await handleTestForumCleanup(interaction);
      }
      return;
    }

    // 2. Handle Button Interactions
    if (interaction.isButton()) {
      const { customId, memberPermissions } = interaction;

      if (!ALL_MANAGED_BUTTON_IDS.has(customId)) {
        return;
      }

      // Verify 'Manage Channels' permission for all managed buttons
      if (!memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({
          content: '❌ この操作を実行するには「チャンネルの管理」権限が必要です。',
          ephemeral: true,
        });
        return;
      }

      if (
        customId === BUTTON_IDS.CONFIRM_DELETE ||
        customId === BUTTON_IDS.CANCEL_DELETE
      ) {
        await handleDisposableChannelButton(interaction);
        return;
      }

      if (
        customId === FORUM_BUTTON_IDS.CONFIRM_DELETE ||
        customId === FORUM_BUTTON_IDS.CANCEL_KEEP
      ) {
        await handleForumThreadButton(interaction);
      }
    }
  } catch (error) {
    console.error('[InteractionHandler] Unhandled error in interaction handler:', error);
  }
}
