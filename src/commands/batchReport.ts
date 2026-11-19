import type { ChatInputCommandInteraction } from 'discord.js';
import { BatchAlreadyRunningError } from '../utils/batchExecution.js';

const MAX_MESSAGE_LENGTH = 2000;

export interface BatchReport {
  summary: string[];
  details: string[];
  filename: string;
}

export async function sendBatchReport(
  interaction: ChatInputCommandInteraction,
  { summary, details, filename }: BatchReport
): Promise<void> {
  const content = [...summary, ...details].join('\n');
  const allowedMentions = { parse: [] };
  const hasAttachment = content.length > MAX_MESSAGE_LENGTH;
  try {
    if (hasAttachment) {
      await interaction.editReply({
        content: [...summary, '詳細は添付ファイルを参照してください。'].join('\n'),
        files: [{ attachment: Buffer.from(content, 'utf8'), name: filename }],
        allowedMentions,
      });
    } else {
      await interaction.editReply({ content, allowedMentions });
    }
    return;
  } catch (error) {
    console.error(`[Command:${interaction.commandName}] Batch finished but sending its report failed:`, error);
  }

  try {
    await interaction.editReply({
      content: [...summary, '⚠️ 詳細を送信できませんでした。'].join('\n'),
      allowedMentions,
    });
  } catch (error) {
    console.error(`[Command:${interaction.commandName}] Could not send the report summary:`, error);
  }
}

export async function replyToBatchFailure(
  interaction: ChatInputCommandInteraction,
  error: unknown
): Promise<void> {
  const running = error instanceof BatchAlreadyRunningError;
  if (!running) console.error(`[Command:${interaction.commandName}] Batch failed:`, error);
  const content = running
    ? 'このバッチはすでに実行中です。完了後に再実行してください。'
    : `⚠️ バッチ実行中にエラーが発生しました: ${error instanceof Error ? error.message : String(error)}`;
  await interaction.editReply({ content: content.slice(0, MAX_MESSAGE_LENGTH), allowedMentions: { parse: [] } });
}
