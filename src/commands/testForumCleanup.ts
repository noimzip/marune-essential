import {
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getConfig } from '../config.js';
import {
  runForumCleanup,
  type ForumCleanupResult,
} from '../services/forumManager.js';
import { replyToBatchFailure, sendBatchReport, type BatchReport } from './batchReport.js';

export const testForumCleanupCommand = new SlashCommandBuilder()
  .setName('test_forum_cleanup')
  .setDescription(
    '長期間更新のないフォーラムトピックの検出・削除確認送信をテスト実行します'
  )
  .addIntegerOption((option) =>
    option
      .setName('days')
      .setDescription('判定基準となる未更新日数（デフォルト: 21日、0以上で指定可）')
      .setMinValue(0)
      .setRequired(false)
  )
  .addBooleanOption((option) =>
    option
      .setName('dry_run')
      .setDescription('true: 送信せず対象一覧のみ表示 / false: 確認メッセージを送信（デフォルト: true）')
      .setRequired(false)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

function formatForumCleanupReport(result: ForumCleanupResult): BatchReport {
  const modeLabel = result.dryRun
    ? '🧪 ドライラン（送信なし）'
    : '📨 テスト実行（確認メッセージ送信）';

  const summary = [
    `**${modeLabel}** (基準: **${result.thresholdDays}日以上**未更新)`,
    `- **検査フォーラム数**: ${result.inspectedForumCount} 件`,
    `- **検査トピック数**: ${result.inspectedThreadCount} 件 (ピン留め除外: ${result.skippedPinnedCount} 件)`,
    `- **検出対象トピック**: ${result.targets.length} 件`,
    `- **エラー**: ${result.errors.length} 件`,
  ];

  if (!result.dryRun) {
    summary.push(
      `- **確認メッセージ送信**: ${result.confirmSentThreads.length} 件 (送信済み/見送り猶予スキップ: ${result.skippedAlreadyConfirmedCount} 件)`
    );
  }

  const details: string[] = [];

  if (result.targets.length > 0) {
    details.push('\n📋 **対象トピック一覧**');
    const sentThreadIds = new Set(result.confirmSentThreads.map(({ threadId }) => threadId));

    for (const target of result.targets) {
      const statusTag = result.dryRun
        ? target.alreadyConfirmed
          ? ' [確認/見送り済]'
          : ''
        : sentThreadIds.has(target.threadId)
        ? ' [送信完了]'
        : ' [スキップ]';

      details.push(`- \`#${target.forumName}\` / **${target.threadName}** (最終投稿: ${target.lastPostDateStr}・${target.elapsedDays}日経過)${statusTag}`);
    }
  } else {
    details.push('\n該当する長期未更新トピックはありませんでした。');
  }

  if (result.errors.length > 0) {
    details.push('\n⚠️ **エラー詳細**', ...result.errors.map((error) => `- ${error}`));
  }

  return { summary, details, filename: 'forum-cleanup-report.txt' };
}

export async function handleTestForumCleanup(
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

  const defaultDays = (() => {
    try {
      return getConfig().FORUM_INACTIVE_DAYS;
    } catch {
      return 21;
    }
  })();

  const days = interaction.options.getInteger('days') ?? defaultDays;
  const dryRun = interaction.options.getBoolean('dry_run') ?? true;

  await interaction.deferReply({ ephemeral: true });

  let result: ForumCleanupResult;
  try {
    result = await runForumCleanup(interaction.client, {
      days,
      dryRun,
    });

  } catch (error) {
    await replyToBatchFailure(interaction, error);
    return;
  }

  await sendBatchReport(interaction, formatForumCleanupReport(result));
}
