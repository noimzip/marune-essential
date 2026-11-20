import { type ChatInputCommandInteraction, type SlashCommandBuilder } from 'discord.js';
import { dailyBatchRunCommand, handleDailyBatchRun } from './dailyBatchRun.js';
import { kadaiCommand, handleKadai } from './kadai.js';
import {
  forumCleanupStatusCommand,
  handleForumCleanupStatus,
  handleTestForumCleanup,
  testForumCleanupCommand,
} from './testForumCleanup.js';

interface SlashCommand {
  definition: Pick<SlashCommandBuilder, 'name' | 'toJSON'>;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
}

const commands: readonly SlashCommand[] = [
  { definition: dailyBatchRunCommand, execute: handleDailyBatchRun },
  { definition: testForumCleanupCommand, execute: handleTestForumCleanup },
  { definition: forumCleanupStatusCommand, execute: handleForumCleanupStatus },
  { definition: kadaiCommand, execute: handleKadai },
];

export function getGuildCommandDefinitions() {
  return commands.map(({ definition }) => definition.toJSON());
}

export async function dispatchSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const command = commands.find(({ definition }) => definition.name === interaction.commandName);
  if (!command) return;

  await command.execute(interaction);
}
