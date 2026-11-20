import { MessageFlags, type Interaction } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dailyBatchRunCommand, handleDailyBatchRun } from '../src/commands/dailyBatchRun.js';
import { kadaiCommand, handleKadai } from '../src/commands/kadai.js';
import { getGuildCommandDefinitions } from '../src/commands/registry.js';
import {
  forumCleanupStatusCommand,
  handleForumCleanupStatus,
  handleTestForumCleanup,
  testForumCleanupCommand,
} from '../src/commands/testForumCleanup.js';
import { configSchema, setConfig } from '../src/config.js';
import { handleInteraction } from '../src/handlers/interactionHandler.js';

vi.mock('../src/commands/dailyBatchRun.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/commands/dailyBatchRun.js')>(),
  handleDailyBatchRun: vi.fn(),
}));
vi.mock('../src/commands/kadai.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/commands/kadai.js')>(),
  handleKadai: vi.fn(),
}));
vi.mock('../src/commands/testForumCleanup.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/commands/testForumCleanup.js')>(),
  handleForumCleanupStatus: vi.fn(),
  handleTestForumCleanup: vi.fn(),
}));

const environment = {
  DISCORD_TOKEN: 'test',
  GUILD_ID: 'guild',
  CATEGORY_ID: 'category',
};

function slashInteraction(commandName: string) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction = { commandName, isChatInputCommand: () => true, reply } as unknown as Interaction;
  return { interaction, reply };
}

afterEach(() => vi.clearAllMocks());

describe('WebClass settings', () => {
  it('requires an explicit opt-in for WebClass', () => {
    expect(configSchema.parse(environment).WEBCLASS_ENABLED).toBe(false);
    expect(configSchema.parse({ ...environment, WEBCLASS_ENABLED: 'true' }).WEBCLASS_ENABLED).toBe(true);
    expect(configSchema.parse({ ...environment, WEBCLASS_ENABLED: 'false' }).WEBCLASS_ENABLED).toBe(false);
    expect(configSchema.safeParse({ ...environment, WEBCLASS_ENABLED: 'typo' }).success).toBe(false);
  });

  it('blocks a previously registered /kadai after turning WebClass off', async () => {
    setConfig(configSchema.parse({ ...environment, WEBCLASS_ENABLED: 'false' }));
    const { interaction, reply } = slashInteraction(kadaiCommand.name);

    await handleInteraction(interaction);

    expect(handleKadai).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
  });
});

describe('guild slash commands', () => {
  it('registers the existing definitions and includes /kadai when enabled', () => {
    const defaultCommands = [
      dailyBatchRunCommand.toJSON(),
      testForumCleanupCommand.toJSON(),
      forumCleanupStatusCommand.toJSON(),
    ];
    const disabled = configSchema.parse(environment);
    const enabled = configSchema.parse({ ...environment, WEBCLASS_ENABLED: 'true' });

    expect(getGuildCommandDefinitions(disabled)).toEqual(defaultCommands);
    expect(getGuildCommandDefinitions(enabled)).toEqual([...defaultCommands, kadaiCommand.toJSON()]);
  });

  it.each([
    { name: dailyBatchRunCommand.name, execute: handleDailyBatchRun, webClass: 'false' },
    { name: testForumCleanupCommand.name, execute: handleTestForumCleanup, webClass: 'false' },
    { name: forumCleanupStatusCommand.name, execute: handleForumCleanupStatus, webClass: 'false' },
    { name: kadaiCommand.name, execute: handleKadai, webClass: 'true' },
  ])('dispatches /$name to its handler', async ({ name, execute, webClass }) => {
    setConfig(configSchema.parse({ ...environment, WEBCLASS_ENABLED: webClass }));
    const { interaction, reply } = slashInteraction(name);

    await handleInteraction(interaction);

    expect(execute).toHaveBeenCalledExactlyOnceWith(interaction);
    expect(reply).not.toHaveBeenCalled();
  });
});
