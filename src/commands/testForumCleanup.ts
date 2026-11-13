import {
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getConfig } from '../config.js';
import {
  ForumCleanupResult,
  runForumCleanup,
} from '../services/forumManager.js';

const MAX_DISCORD_MESSAGE_LENGTH = 1950;

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

/**
 * Formats the cleanup result into an ephemeral reply within Discord's 2000-character limit.
 */
export function formatForumCleanupReport(result: ForumCleanupResult): string {
  const modeLabel = result.dryRun
    ? '🧪 ドライラン（送信なし）'
    : '📨 テスト実行（確認メッセージ送信）';

  const headerLines = [
    `**${modeLabel}** (基準: **${result.thresholdDays}日以上**未更新)`,
    `- **検査フォーラム数**: ${result.inspectedForumCount} 件`,
    `- **検査トピック数**: ${result.inspectedThreadCount} 件 (ピン留め除外: ${result.skippedPinnedCount} 件)`,
    `- **検出対象トピック**: ${result.targets.length} 件`,
  ];

  if (!result.dryRun) {
    headerLines.push(
      `- **確認メッセージ送信**: ${result.confirmSentThreads.length} 件 (送信済み/見送り猶予スキップ: ${result.skippedAlreadyConfirmedCount} 件)`
    );
  }

  const lines = [...headerLines];

  if (result.targets.length > 0) {
    lines.push('\n📋 **対象トピック一覧**:');
    let omittedCount = 0;

    for (const target of result.targets) {
      const statusTag = result.dryRun
        ? target.alreadyConfirmed
          ? ' [確認/見送り済]'
          : ''
        : result.confirmSentThreads.some((s) => s.threadId === target.threadId)
        ? ' [送信完了]'
        : ' [スキップ]';

      const entry = `- \`#${target.forumName}\` / **${target.threadName}** (最終投稿: ${target.lastPostDateStr}・${target.elapsedDays}日経過)${statusTag}`;
      const candidate = [...lines, entry].join('\n');

      if (candidate.length > MAX_DISCORD_MESSAGE_LENGTH - 150) {
        omittedCount++;
      } else {
        lines.push(entry);
      }
    }

    if (omittedCount > 0) {
      lines.push(`*(...他 ${omittedCount} 件省略)*`);
    }
  } else {
    lines.push('\n該当する長期未更新トピックはありませんでした。');
  }

  if (result.errors.length > 0) {
    const errorBlock =
      '\n⚠️ **エラー詳細**:\n' +
      result.errors.slice(0, 5).map((e) => `- ${e}`).join('\n');
    const current = lines.join('\n');
    if (current.length + errorBlock.length <= MAX_DISCORD_MESSAGE_LENGTH) {
      lines.push(errorBlock);
    }
  }

  return lines.join('\n');
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

  try {
    const result = await runForumCleanup(interaction.client, {
      days,
      dryRun,
    });

    await interaction.editReply({
      content: formatForumCleanupReport(result),
    });
  } catch (error: any) {
    console.error('[Command:test_forum_cleanup] Error running forum cleanup:', error);
    const errorContent = `⚠️ フォーラムクリーンアップ実行中にエラーが発生しました: ${error.message ?? error}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: errorContent });
    } else {
      await interaction.reply({ content: errorContent, ephemeral: true });
    }
  }
}
