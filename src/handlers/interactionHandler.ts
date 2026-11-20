import {
  type ButtonInteraction,
  ChannelFlags,
  ChannelType,
  type ForumChannel,
  type GuildBasedChannel,
  Interaction,
  PermissionFlagsBits,
  type ThreadChannel,
} from 'discord.js';
import { getConfig, parseExcludedForumIds } from '../config.js';
import { calculateDiffDays } from '../utils/dateUtils.js';
import { BUTTON_IDS, DISPOSABLE_POSTPONE_MARKER } from '../services/channelManager.js';
import {
  FORUM_BUTTON_IDS,
  FORUM_KEEP_MARKER,
  classifyForumBotMessage,
} from '../services/forumManager.js';
import { withTemporaryThreadUnarchive } from '../services/forumThreadArchive.js';
import { handleDailyBatchRun } from '../commands/dailyBatchRun.js';
import { handleKadai } from '../commands/kadai.js';
import { forumCleanupStatusCommand, handleForumCleanupStatus, handleTestForumCleanup } from '../commands/testForumCleanup.js';

const ALL_MANAGED_BUTTON_IDS = new Set<string>([
  BUTTON_IDS.CONFIRM_DELETE,
  BUTTON_IDS.CANCEL_DELETE,
  FORUM_BUTTON_IDS.CONFIRM_DELETE,
  FORUM_BUTTON_IDS.CANCEL_KEEP,
]);

const CHANNEL_FETCH_OPTIONS = { force: true, cache: false };
const MESSAGE_CHECK_LIMIT = 100;

async function fetchCurrentGuildChannel(
  interaction: ButtonInteraction,
  channelId: string,
): Promise<GuildBasedChannel | null> {
  try {
    const channel =
      (await interaction.guild?.channels.fetch(channelId, CHANNEL_FETCH_OPTIONS)) ??
      (await interaction.client.channels.fetch(channelId, CHANNEL_FETCH_OPTIONS));
    return channel && 'guildId' in channel && channel.guildId === interaction.guildId
      ? channel
      : null;
  } catch (error) {
    console.error('[InteractionHandler] Failed to verify current channel:', error);
    return null;
  }
}

function discordErrorCode(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
}

async function replyDeleteError(
  interaction: ButtonInteraction,
  error: unknown,
  targetLabel: string,
): Promise<void> {
  console.error(`[InteractionHandler] Error deleting ${targetLabel}:`, error);
  const code = discordErrorCode(error);
  const message = code === 50013
    ? `Botにこの${targetLabel}を削除する権限がありません。`
    : code === 10003
      ? `この${targetLabel}は既に削除されているか、見つかりません。`
      : `${targetLabel}の削除に失敗しました。`;
  await interaction.editReply({ content: `⚠️ ${message}` });
}

async function handleDisposableChannelButton(
  interaction: ButtonInteraction
): Promise<void> {
  const { customId } = interaction;

  if (customId === BUTTON_IDS.CONFIRM_DELETE) {
    await interaction.deferReply({ ephemeral: true });
    const config = getConfig();
    const channel = interaction.guildId === config.GUILD_ID
      ? await fetchCurrentGuildChannel(interaction, interaction.channelId)
      : null;

    if (!channel) {
      await interaction.editReply({ content: '⚠️ 現在のチャンネル情報を確認できないため、削除を見送りました。' });
      return;
    }

    const age = calculateDiffDays(channel.name, new Date(), channel.createdAt ?? undefined);
    if (channel.type !== ChannelType.GuildText || channel.parentId !== config.CATEGORY_ID || age === null || age <= 0) {
      await interaction.editReply({ content: '⚠️ 現在のチャンネルは削除対象の使い捨て会話ではありません。' });
      return;
    }

    await interaction.editReply({ content: '🗑️ チャンネルを削除しています...' });
    const executorTag = interaction.user.tag ?? interaction.user.username;
    try {
      await channel.delete(`ユーザー承認による使い捨てチャンネル手動削除 (実行者: ${executorTag})`);
    } catch (error) {
      await replyDeleteError(interaction, error, 'チャンネル');
    }
    return;
  }

  if (customId === BUTTON_IDS.CANCEL_DELETE) {
    try {
      await interaction.update({
        content: `${DISPOSABLE_POSTPONE_MARKER}(担当者: <@${interaction.user.id}>)`,
        components: [],
        allowedMentions: { parse: [] },
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

async function forumDeleteBlockReason(
  interaction: ButtonInteraction,
  thread: ThreadChannel,
  forum: ForumChannel,
): Promise<string | undefined> {
  if (thread.flags?.has(ChannelFlags.Pinned)) {
    return 'トピックがピン留めされているため、削除を見送りました。';
  }

  try {
    const bot = forum.guild.members.me ?? await forum.guild.members.fetchMe();
    if (!forum.permissionsFor(bot)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
      return 'トピックの投稿を確認する権限がないため、削除を見送りました。';
    }

    const confirmation = await thread.messages.fetch({
      message: interaction.message.id,
      ...CHANNEL_FETCH_OPTIONS,
    });
    if (classifyForumBotMessage(confirmation, bot.id) !== 'confirm') {
      return '現在有効な削除確認ではないため、削除を見送りました。';
    }

    const recent = await thread.messages.fetch({
      after: confirmation.id,
      limit: MESSAGE_CHECK_LIMIT,
      cache: false,
    });
    if (recent.some((message) => classifyForumBotMessage(message, bot.id) === null)) {
      return '削除確認後に新しい投稿があるため、削除を見送りました。';
    }
    if (recent.size >= MESSAGE_CHECK_LIMIT) {
      return '削除確認後の投稿をすべて確認できないため、削除を見送りました。';
    }
  } catch (error) {
    console.error('[ForumButton] Failed to verify current thread messages:', error);
    return 'トピックの投稿を確認できないため、削除を見送りました。';
  }
}

async function handleForumThreadButton(interaction: ButtonInteraction): Promise<void> {
  const deleting = interaction.customId === FORUM_BUTTON_IDS.CONFIRM_DELETE;
  if (deleting) {
    await interaction.deferReply({ ephemeral: true });
  } else {
    await interaction.deferUpdate();
  }

  const config = getConfig();
  const thread = interaction.guildId === config.GUILD_ID
    ? await fetchCurrentGuildChannel(interaction, interaction.channelId)
    : null;
  const forum = thread?.type === ChannelType.PublicThread && thread.parentId
    ? await fetchCurrentGuildChannel(interaction, thread.parentId)
    : null;
  if (thread?.type !== ChannelType.PublicThread || forum?.type !== ChannelType.GuildForum) {
    const content = '⚠️ この操作はフォーラムチャンネル配下のトピック内でのみ有効です。現在の所属先を確認できない場合は操作を見送ります。';
    if (deleting) {
      await interaction.editReply({ content });
    } else {
      await interaction.followUp({ content, ephemeral: true });
    }
    return;
  }

  if (deleting) {
    const blocked = parseExcludedForumIds(config.EXCLUDED_FORUM_IDS).includes(forum.id)
      ? 'このフォーラムは削除確認の対象外です。'
      : await forumDeleteBlockReason(interaction, thread, forum);
    if (blocked) {
      await interaction.editReply({ content: `⚠️ ${blocked}` });
      return;
    }

    await interaction.editReply({ content: '✅ 削除が承認されました。このトピックを削除します。' });
    const executorTag = interaction.user.tag ?? interaction.user.username;
    const auditReason = `長期未更新フォーラムトピック削除承認 (承認者: ${executorTag})`;
    try {
      await thread.delete(auditReason);
    } catch (error) {
      if (discordErrorCode(error) !== 50083) {
        await replyDeleteError(interaction, error, 'トピック');
        return;
      }

      let blockedAfterOpening: string | undefined;
      try {
        await withTemporaryThreadUnarchive(thread, {
          openReason: 'トピック削除のためアーカイブ解除',
          closeReason: 'トピック削除失敗後の再クローズ',
          afterSuccess: 'deleted',
          forceOpen: true,
        }, async () => {
          const currentThread = await fetchCurrentGuildChannel(interaction, thread.id);
          if (currentThread?.type !== ChannelType.PublicThread || currentThread.parentId !== forum.id) {
            blockedAfterOpening = '現在のトピック情報を確認できないため、削除を見送りました。';
          } else {
            blockedAfterOpening = await forumDeleteBlockReason(interaction, currentThread, forum);
          }
          if (blockedAfterOpening) throw new Error(blockedAfterOpening);
          await thread.delete(auditReason);
        });
      } catch (retryError) {
        if (blockedAfterOpening) {
          await interaction.editReply({ content: `⚠️ ${blockedAfterOpening}` });
        } else {
          await replyDeleteError(interaction, retryError, 'トピック');
        }
      }
    }
    return;
  }

  try {
    await withTemporaryThreadUnarchive(thread, {
      openReason: '見送り処理のためアーカイブ一時解除',
      closeReason: '見送り処理後の再クローズ',
      afterSuccess: 'restore',
    }, () => interaction.editReply({
      content: `${FORUM_KEEP_MARKER}（承認者: <@${interaction.user.id}>）`,
      components: [],
      allowedMentions: { parse: [] },
    }));
  } catch (error) {
    console.error('[ForumButton] Failed to update the keep message:', error);
    await interaction.followUp({
      content: '⚠️ 見送り処理に失敗しました。',
      ephemeral: true,
    });
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
      } else if (interaction.commandName === forumCleanupStatusCommand.name) {
        await handleForumCleanupStatus(interaction);
      } else if (interaction.commandName === 'kadai') {
        await handleKadai(interaction);
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
