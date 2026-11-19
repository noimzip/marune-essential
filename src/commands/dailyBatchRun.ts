import {
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { runDailyLifecycle, type LifecycleResult } from '../services/channelManager.js';
import { replyToBatchFailure, sendBatchReport } from './batchReport.js';

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

  let result: LifecycleResult;
  try {
    result = await runDailyLifecycle(interaction.client);
  } catch (error) {
    await replyToBatchFailure(interaction, error);
    return;
  }

  const summary = [
    '✅ **定期バッチの即時実行が完了しました**',
    `- **当日チャンネル作成**: ${result.created ? `1 件 (#${result.createdChannelName})` : '0 件'}`,
    `- **削除確認送信**: ${result.confirmSentChannels.length} 件`,
    `- **7日経過自動削除**: ${result.deletedChannels.length} 件`,
    `- **エラー**: ${result.errors.length} 件`,
  ];
  const details: string[] = [];
  if (result.confirmSentChannels.length) {
    details.push('\n**削除確認送信先**', ...result.confirmSentChannels.map((name) => `- #${name}`));
  }
  if (result.deletedChannels.length) {
    details.push('\n**削除したチャンネル**', ...result.deletedChannels.map((name) => `- #${name}`));
  }
  if (result.errors.length) {
    details.push('\n⚠️ **エラー詳細**', ...result.errors.map((error) => `- ${error}`));
  }
  await sendBatchReport(interaction, { summary, details, filename: 'daily-batch-report.txt' });
}
