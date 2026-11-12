import {
  Interaction,
  PermissionFlagsBits,
  TextChannel,
} from 'discord.js';
import { BUTTON_IDS } from '../services/channelManager.js';
import { handleDailyBatchRun } from '../commands/dailyBatchRun.js';

export async function handleInteraction(interaction: Interaction): Promise<void> {
  try {
    // 1. Handle Slash Commands
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'daily-batch-run') {
        await handleDailyBatchRun(interaction);
      }
      return;
    }

    // 2. Handle Button Interactions
    if (interaction.isButton()) {
      const { customId, memberPermissions } = interaction;

      if (
        customId !== BUTTON_IDS.CONFIRM_DELETE &&
        customId !== BUTTON_IDS.CANCEL_DELETE
      ) {
        return;
      }

      // Verify 'Manage Channels' permission
      if (!memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.reply({
          content: '❌ この操作を実行するには「チャンネルの管理」権限が必要です。',
          ephemeral: true,
        });
        return;
      }

      if (customId === BUTTON_IDS.CONFIRM_DELETE) {
        let channel: any = interaction.channel;
        if (!channel && interaction.channelId) {
          try {
            channel =
              (await interaction.guild?.channels.fetch(interaction.channelId)) ??
              (await interaction.client.channels.fetch(interaction.channelId));
          } catch (fetchErr) {
            console.error('[Button:Confirm] Failed to fetch channel:', fetchErr);
          }
        }

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
          console.error('[Button:Confirm] Error deleting channel:', err);
          const errorMessage =
            err.code === 50013
              ? 'Botにこのチャンネルを削除する権限（チャンネルの管理）がありません。'
              : err.code === 10003
              ? 'このチャンネルは既に削除されているか、見つかりません。'
              : `チャンネルの削除に失敗しました: ${err.message ?? err}`;

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
        return;
      }

      if (customId === BUTTON_IDS.CANCEL_DELETE) {
        // Postpone: update message to remove buttons and note postponement
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
        return;
      }
    }
  } catch (error) {
    console.error('[InteractionHandler] Unhandled error in interaction handler:', error);
  }
}
