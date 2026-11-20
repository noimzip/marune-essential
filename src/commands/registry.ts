import { MessageFlags, type ChatInputCommandInteraction, type SlashCommandBuilder } from 'discord.js';
import { getConfig, type Config } from '../config.js';
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
  enabled?: (config: Config) => boolean;
}

const commands: readonly SlashCommand[] = [
  { definition: dailyBatchRunCommand, execute: handleDailyBatchRun },
  { definition: testForumCleanupCommand, execute: handleTestForumCleanup },
  { definition: forumCleanupStatusCommand, execute: handleForumCleanupStatus },
  {
    definition: kadaiCommand,
    execute: handleKadai,
    enabled: (config) => config.WEBCLASS_ENABLED,
  },
];

export function getGuildCommandDefinitions(config: Config) {
  return commands
    .filter((command) => command.enabled?.(config) ?? true)
    .map(({ definition }) => definition.toJSON());
}

export async function dispatchSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const command = commands.find(({ definition }) => definition.name === interaction.commandName);
  if (!command) return;

  if (command.enabled && !command.enabled(getConfig())) {
    await interaction.reply({
      content: `このサーバーでは /${command.definition.name} は無効です。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await command.execute(interaction);
}
