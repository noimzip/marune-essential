import {
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { getConfig } from '../config.js';
import {
  runForumCleanup,
  type ForumCleanupResult,
} from '../services/forumManager.js';
import { describeBatchFailure, sendBatchReport, type BatchReport } from './batchReport.js';

const INTERACTION_TOKEN_LIFETIME_MS = 15 * 60 * 1000;
const RESULT_RETENTION_MS = 24 * 60 * 60 * 1000;
const REPORT_FILENAME = 'forum-cleanup-report.txt';
const RUN_ID_OPTION = 'run_id';

interface ForumCleanupRun {
  guildId: string;
  userId: string;
  report?: BatchReport;
}

const forumCleanupRuns = new Map<string, ForumCleanupRun>();

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

export const forumCleanupStatusCommand = new SlashCommandBuilder()
  .setName('forum_cleanup_status')
  .setDescription('フォーラム検査の実行状態や結果を確認します')
  .addStringOption((option) =>
    option
      .setName(RUN_ID_OPTION)
      .setDescription('検査開始時に表示された実行ID')
      .setRequired(true)
  )
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels);

function formatForumCleanupReport(result: ForumCleanupResult): BatchReport {
  const modeLabel = result.dryRun
    ? '🧪 フォーラム検査完了（ドライラン）'
    : '✅ フォーラム検査完了（確認メッセージ送信）';

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
        : ' [確認送信なし]';

      details.push(`- \`#${target.forumName}\` / **${target.threadName}** (最終投稿: ${target.lastPostDateStr}・${target.elapsedDays}日経過)${statusTag}`);
    }
  } else {
    details.push('\n該当する長期未更新トピックはありませんでした。');
  }

  if (result.errors.length > 0) {
    details.push('\n⚠️ **エラー詳細**', ...result.errors.map((error) => `- ${error}`));
  }

  return { summary, details, filename: REPORT_FILENAME };
}

async function getAuthorizedGuildId(
  interaction: ChatInputCommandInteraction
): Promise<string | null> {
  if (interaction.guildId && interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)) {
    return interaction.guildId;
  }
  await interaction.reply({
    content: '❌ このコマンドを実行するには「チャンネルの管理」権限が必要です。',
    flags: MessageFlags.Ephemeral,
  });
  return null;
}

export async function handleTestForumCleanup(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const guildId = await getAuthorizedGuildId(interaction);
  if (!guildId) return;

  const config = getConfig();
  if (guildId !== config.GUILD_ID) {
    await interaction.reply({
      content: 'このサーバーではフォーラム検査を実行できません。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const days = interaction.options.getInteger('days') ?? config.FORUM_INACTIVE_DAYS;
  const dryRun = interaction.options.getBoolean('dry_run') ?? true;
  const runId = interaction.id;
  const statusHint = `状態と結果は \`/${forumCleanupStatusCommand.name} ${RUN_ID_OPTION}:${runId}\` で確認できます。`;
  const run: ForumCleanupRun = { guildId, userId: interaction.user.id };
  forumCleanupRuns.set(runId, run);

  try {
    await interaction.reply({
      content: `フォーラム検査を開始しました。\n${statusHint}`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    forumCleanupRuns.delete(runId);
    throw error;
  }

  let report: BatchReport;
  try {
    const result = await runForumCleanup(interaction.client, { days, dryRun });
    report = formatForumCleanupReport(result);
  } catch (error) {
    report = {
      summary: ['**フォーラム検査の実行に失敗しました**'],
      details: [describeBatchFailure(interaction.commandName, error)],
      filename: REPORT_FILENAME,
    };
  }

  report.summary.push(statusHint);
  run.report = report;
  setTimeout(() => forumCleanupRuns.delete(runId), RESULT_RETENTION_MS).unref();

  if (Date.now() - interaction.createdTimestamp < INTERACTION_TOKEN_LIFETIME_MS) {
    await sendBatchReport(interaction, report);
  }
}

export async function handleForumCleanupStatus(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const guildId = await getAuthorizedGuildId(interaction);
  if (!guildId) return;

  const runId = interaction.options.getString(RUN_ID_OPTION, true).trim();
  const run = forumCleanupRuns.get(runId);
  if (run?.guildId !== guildId || run.userId !== interaction.user.id) {
    await interaction.reply({
      content: '指定された実行IDの検査が見つかりませんでした。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!run.report) {
    await interaction.reply({
      content: 'フォーラム検査は実行中です。時間をおいて再度確認してください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  await sendBatchReport(interaction, run.report);
}
