import { type Interaction } from 'discord.js';
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

function slashInteraction(commandName: string) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const interaction = { commandName, isChatInputCommand: () => true, reply } as unknown as Interaction;
  return { interaction, reply };
}

afterEach(() => vi.clearAllMocks());

describe('guild slash commands', () => {
  it('registers the existing command definitions', () => {
    expect(getGuildCommandDefinitions()).toEqual([
      dailyBatchRunCommand.toJSON(),
      testForumCleanupCommand.toJSON(),
      forumCleanupStatusCommand.toJSON(),
      kadaiCommand.toJSON(),
    ]);
  });

  it.each([
    { name: dailyBatchRunCommand.name, execute: handleDailyBatchRun },
    { name: testForumCleanupCommand.name, execute: handleTestForumCleanup },
    { name: forumCleanupStatusCommand.name, execute: handleForumCleanupStatus },
    { name: kadaiCommand.name, execute: handleKadai },
  ])('dispatches /$name to its handler', async ({ name, execute }) => {
    const { interaction, reply } = slashInteraction(name);

    await handleInteraction(interaction);

    expect(execute).toHaveBeenCalledExactlyOnceWith(interaction);
    expect(reply).not.toHaveBeenCalled();
  });
});
