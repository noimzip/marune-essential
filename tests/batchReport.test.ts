import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentPayload, ChatInputCommandInteraction, InteractionEditReplyOptions } from 'discord.js';
import { handleDailyBatchRun } from '../src/commands/dailyBatchRun.js';
import { handleTestForumCleanup } from '../src/commands/testForumCleanup.js';
import * as channelManager from '../src/services/channelManager.js';
import * as forumManager from '../src/services/forumManager.js';

afterEach(() => vi.restoreAllMocks());

function mockInteraction(commandName: string) {
  const editReply = vi.fn<(options: InteractionEditReplyOptions) => Promise<void>>().mockResolvedValue(undefined);
  const interaction = {
    commandName,
    client: {},
    memberPermissions: { has: () => true },
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply,
    options: { getInteger: () => 21, getBoolean: () => true },
  } as unknown as ChatInputCommandInteraction;
  return { interaction, editReply };
}

function attachmentText(reply: InteractionEditReplyOptions): string {
  const attachment = reply.files?.[0];
  if (!attachment || typeof attachment !== 'object' || !('attachment' in attachment)) {
    throw new Error('Expected a report attachment');
  }
  return String((attachment as AttachmentPayload).attachment);
}

describe('admin command report delivery', () => {
  const dailyResult = {
    created: false,
    createdChannel: null,
    todayChannel: null,
    createdChannelName: '使い捨て会話_11月19日',
    confirmSentChannels: Array.from({ length: 30 }, (_, i) => `${i}-${'名前'.repeat(48)}`),
    deletedChannels: [],
    skippedChannels: [],
    errors: ['最初のエラー', '最後のエラー'],
  };

  it('keeps daily batch counts in the message and puts all long names and errors in the attachment', async () => {
    vi.spyOn(channelManager, 'runDailyLifecycle').mockResolvedValue(dailyResult);
    const { interaction, editReply } = mockInteraction('daily-batch-run');
    await handleDailyBatchRun(interaction);

    const reply = editReply.mock.calls[0][0];
    expect(reply.content?.length).toBeLessThanOrEqual(2000);
    expect(reply.content).toContain('削除確認送信**: 30 件');
    expect(reply.content).toContain('エラー**: 2 件');
    expect(attachmentText(reply)).toContain(dailyResult.confirmSentChannels.at(-1));
    expect(attachmentText(reply)).toContain('最後のエラー');
  });

  it('keeps forum counts visible and includes all errors in its long report', async () => {
    const targets = Array.from({ length: 30 }, (_, i) => ({
      forumId: 'forum',
      forumName: 'フォーラム',
      threadId: String(i),
      threadName: `${i}-${'とても長い'.repeat(20)}`,
      lastPostDate: new Date('2026-10-01'),
      lastPostDateStr: '2026/10/01',
      elapsedDays: 30,
      alreadyConfirmed: false,
      archived: true,
    }));
    vi.spyOn(forumManager, 'runForumCleanup').mockResolvedValue({
      inspectedForumCount: 1,
      inspectedThreadCount: 30,
      skippedPinnedCount: 0,
      skippedAlreadyConfirmedCount: 0,
      targets,
      confirmSentThreads: [],
      errors: Array.from({ length: 7 }, (_, i) => `エラー ${i + 1}`),
      dryRun: true,
      thresholdDays: 21,
    });
    const { interaction, editReply } = mockInteraction('test_forum_cleanup');
    await handleTestForumCleanup(interaction);

    const reply = editReply.mock.calls[0][0];
    expect(reply.content?.length).toBeLessThanOrEqual(2000);
    expect(reply.content).toContain('検出対象トピック**: 30 件');
    expect(reply.content).toContain('エラー**: 7 件');
    expect(attachmentText(reply)).toContain(targets.at(-1)?.threadName);
    expect(attachmentText(reply)).toContain('エラー 7');
  });

  it('falls back to a completion summary if sending the report fails', async () => {
    vi.spyOn(channelManager, 'runDailyLifecycle').mockResolvedValue(dailyResult);
    const { interaction, editReply } = mockInteraction('daily-batch-run');
    editReply.mockRejectedValueOnce(new Error('attachment rejected'));
    await handleDailyBatchRun(interaction);

    expect(editReply).toHaveBeenCalledTimes(2);
    expect(editReply.mock.calls[1][0].content).toContain('定期バッチの即時実行が完了しました');
    expect(editReply.mock.calls[1][0].content).toContain('エラー**: 2 件');
    expect(editReply.mock.calls[1][0].content).toContain('詳細を送信できませんでした');
  });
});
