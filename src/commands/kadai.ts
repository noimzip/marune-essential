import { type ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder } from 'discord.js';
import { formatAssignmentMessage } from '../services/assignmentMessages.js';
import { getUpcomingAssignments, WebClassError } from '../services/webClass.js';

const COOLDOWN_MS = 15 * 60 * 1000;
const nextAllowedAt = new Map<string, number>();

export const kadaiCommand = new SlashCommandBuilder()
  .setName('kadai')
  .setDescription('WebClassで締切が今後7日以内の課題を表示します（15分に1回）');

export async function handleKadai(interaction: ChatInputCommandInteraction): Promise<void> {
  const now = Date.now();
  for (const [userId, expiresAt] of nextAllowedAt) {
    if (expiresAt <= now) nextAllowedAt.delete(userId);
  }

  const expiresAt = nextAllowedAt.get(interaction.user.id);
  if (expiresAt !== undefined) {
    await interaction.reply({
      content: `/kadai は15分に1回利用できます。もう一度使えるのは <t:${Math.ceil(expiresAt / 1000)}:R> です。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  nextAllowedAt.set(interaction.user.id, now + COOLDOWN_MS);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  let assignments;
  try {
    assignments = await getUpcomingAssignments(new Date(now));
  } catch (error) {
    await interaction.editReply({
      content: error instanceof WebClassError ? error.message : 'WebClass の課題取得に失敗しました。',
    });
    return;
  }
  await interaction.editReply(formatAssignmentMessage(assignments));
}
