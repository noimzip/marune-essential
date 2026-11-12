import {
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { runDailyLifecycle } from '../services/channelManager.js';

export const dailyBatchRunCommand = new SlashCommandBuilder()
  .setName('daily-batch-run')
  .setDescription('0:00の定期バッチ（使い捨て会話チャンネルの生成・削除確認・自動削除）を即時実行します')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

export async function handleDailyBatchRun(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const memberPermissions = interaction.memberPermissions;
  if (!memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: '❌ このコマンドを実行するには「チャンネルの管理」権限が必要です。',
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await runDailyLifecycle(interaction.client);

    const lines = [
      '✅ **定期バッチの即時実行が完了しました**',
      `- **当日チャンネル作成**: ${
        result.created ? `\`#${result.createdChannelName}\`` : '既存のためスキップ'
      }`,
      `- **削除確認送信**: ${result.confirmSentChannels.length} 件 (${
        result.confirmSentChannels.map((c) => `\`#${c}\``).join(', ') || 'なし'
      })`,
      `- **7日経過自動削除**: ${result.deletedChannels.length} 件 (${
        result.deletedChannels.map((c) => `\`#${c}\``).join(', ') || 'なし'
      })`,
    ];

    if (result.errors.length > 0) {
      lines.push(
        '\n⚠️ **エラー詳細**:\n' + result.errors.map((e) => `- ${e}`).join('\n')
      );
    }

    await interaction.editReply({
      content: lines.join('\n'),
    });
  } catch (error: any) {
    console.error('[Command:daily-batch-run] Error running daily lifecycle:', error);
    const errorContent = `⚠️ バッチ実行中にエラーが発生しました: ${error.message ?? error}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({
        content: errorContent,
      });
    } else {
      await interaction.reply({
        content: errorContent,
        ephemeral: true,
      });
    }
  }
}
