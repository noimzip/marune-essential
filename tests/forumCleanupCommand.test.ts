import { MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleForumCleanupStatus,
  handleTestForumCleanup,
} from '../src/commands/testForumCleanup.js';
import { configSchema, setConfig } from '../src/config.js';
import * as forumManager from '../src/services/forumManager.js';

const tokenLifetimeMs = 15 * 60 * 1000;
const result: forumManager.ForumCleanupResult = {
  inspectedForumCount: 2,
  inspectedThreadCount: 901,
  skippedPinnedCount: 0,
  skippedAlreadyConfirmedCount: 0,
  targets: [],
  confirmSentThreads: [],
  errors: ['フォーラムのアーカイブ取得に失敗しました。'],
  dryRun: true,
  thresholdDays: 21,
};

function mockInteraction(
  id: string,
  { runId, guildId = 'guild', userId = 'moderator', canManage = true }: {
    runId?: string;
    guildId?: string;
    userId?: string;
    canManage?: boolean;
  } = {}
) {
  const reply = vi.fn().mockResolvedValue(undefined);
  const deferReply = vi.fn().mockResolvedValue(undefined);
  const editReply = vi.fn().mockResolvedValue(undefined);
  const interaction = {
    id,
    guildId,
    user: { id: userId },
    createdTimestamp: Date.now(),
    commandName: runId ? 'forum_cleanup_status' : 'test_forum_cleanup',
    client: {},
    memberPermissions: { has: (permission: bigint) => canManage && permission === PermissionFlagsBits.ManageChannels },
    options: { getInteger: () => 21, getBoolean: () => true, getString: () => runId },
    reply,
    deferReply,
    editReply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply, deferReply, editReply };
}

beforeEach(() => {
  setConfig(configSchema.parse({ DISCORD_TOKEN: 'test', GUILD_ID: 'guild', CATEGORY_ID: 'category' }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('forum cleanup command results', () => {
  it('acknowledges before scanning and returns the report on the original interaction within 15 minutes', async () => {
    const run = mockInteraction('quick-run');
    const scan = vi.spyOn(forumManager, 'runForumCleanup').mockResolvedValue(result);

    await handleTestForumCleanup(run.interaction);

    expect(run.reply).toHaveBeenCalledWith(expect.objectContaining({
      flags: MessageFlags.Ephemeral,
      content: expect.stringContaining('/forum_cleanup_status run_id:quick-run'),
    }));
    expect(run.reply.mock.invocationCallOrder[0]).toBeLessThan(scan.mock.invocationCallOrder[0]);
    expect(run.editReply).toHaveBeenCalledOnce();
    expect(run.editReply.mock.calls[0][0].content).toContain('検査トピック数**: 901 件');
    expect(run.editReply.mock.calls[0][0].content).toContain(result.errors[0]);
  });

  it('reports both running status and finished counts and errors with a new interaction after expiry', async () => {
    vi.useFakeTimers();
    vi.spyOn(forumManager, 'runForumCleanup').mockImplementation(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, tokenLifetimeMs + 1000));
      return result;
    });
    const run = mockInteraction('long-run');
    run.editReply.mockRejectedValue(new Error('Invalid Webhook Token'));
    const execution = handleTestForumCleanup(run.interaction);
    await vi.advanceTimersByTimeAsync(0);

    const running = mockInteraction('while-running', { runId: 'long-run' });
    await handleForumCleanupStatus(running.interaction);
    expect(running.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('実行中') }));

    await vi.advanceTimersByTimeAsync(tokenLifetimeMs + 1000);
    await execution;

    expect(run.editReply).not.toHaveBeenCalled();
    const finished = mockInteraction('after-expiry', { runId: 'long-run' });
    await handleForumCleanupStatus(finished.interaction);
    expect(finished.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(finished.editReply.mock.calls[0][0].content).toContain('フォーラム検査完了');
    expect(finished.editReply.mock.calls[0][0].content).toContain('検査トピック数**: 901 件');
    expect(finished.editReply.mock.calls[0][0].content).toContain(result.errors[0]);
  });

  it('limits results to the requesting moderator with permission in the same guild', async () => {
    vi.spyOn(forumManager, 'runForumCleanup').mockResolvedValue(result);
    await handleTestForumCleanup(mockInteraction('private-run').interaction);

    for (const [index, options] of [
      { userId: 'other-moderator' },
      { guildId: 'other-guild' },
      { canManage: false },
    ].entries()) {
      const requester = mockInteraction(`unauthorized-${index}`, { runId: 'private-run', ...options });
      await handleForumCleanupStatus(requester.interaction);
      expect(requester.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
      expect(requester.deferReply).not.toHaveBeenCalled();
      expect(requester.editReply).not.toHaveBeenCalled();
    }
  });

  it('rejects a scan requested outside the configured guild', async () => {
    const scan = vi.spyOn(forumManager, 'runForumCleanup');
    const run = mockInteraction('other-guild-run', { guildId: 'old-guild' });

    await handleTestForumCleanup(run.interaction);

    expect(run.reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    expect(scan).not.toHaveBeenCalled();
  });

  it('makes a batch failure available by run ID', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(forumManager, 'runForumCleanup').mockRejectedValue(new Error('フォーラム一覧取得に失敗しました。'));
    await handleTestForumCleanup(mockInteraction('failed-run').interaction);

    const finished = mockInteraction('failed-result', { runId: 'failed-run' });
    await handleForumCleanupStatus(finished.interaction);

    expect(finished.editReply.mock.calls[0][0].content).toContain('フォーラム一覧取得に失敗しました。');
  });

  it('expires completed results after 24 hours', async () => {
    vi.useFakeTimers();
    vi.spyOn(forumManager, 'runForumCleanup').mockResolvedValue(result);
    await handleTestForumCleanup(mockInteraction('old-run').interaction);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    const requester = mockInteraction('after-retention', { runId: 'old-run' });
    await handleForumCleanupStatus(requester.interaction);

    expect(requester.reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('見つかりません') }));
    expect(requester.editReply).not.toHaveBeenCalled();
  });
});
