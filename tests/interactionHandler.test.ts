import { beforeEach, describe, it, expect, vi } from 'vitest';
import { ChannelFlags, ChannelFlagsBitField, ChannelType, Collection, type Interaction, PermissionFlagsBits } from 'discord.js';
import { configSchema, setConfig } from '../src/config.js';
import { formatChannelName } from '../src/utils/dateUtils.js';
import { handleInteraction } from '../src/handlers/interactionHandler.js';
import { BUTTON_IDS } from '../src/services/channelManager.js';
import * as channelManager from '../src/services/channelManager.js';
import {
  FORUM_BUTTON_IDS,
  FORUM_CONFIRM_MARKER,
  FORUM_KEEP_MARKER,
} from '../src/services/forumManager.js';
import * as forumManager from '../src/services/forumManager.js';

const guildId = 'guild-1';
const categoryId = 'category-1';

function mockButton(customId: string, channelId: string, ...channels: { id: string }[]) {
  const channelMap = new Map(channels.map((channel) => [channel.id, channel]));
  const fetch = vi.fn(async (id: string) => channelMap.get(id) ?? null);
  const interaction = {
    isChatInputCommand: () => false,
    isButton: () => true,
    customId,
    channelId,
    guildId,
    guild: { channels: { fetch } },
    client: { channels: { fetch: vi.fn().mockResolvedValue(null) } },
    memberPermissions: { has: (permission: bigint) => permission === PermissionFlagsBits.ManageChannels },
    user: { id: 'moderator', tag: 'Moderator#0001' },
    message: { id: 'confirmation' },
    channel: null as object | null,
    deferReply: vi.fn().mockResolvedValue(undefined),
    deferUpdate: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
  };
  return { interaction, fetch, run: () => handleInteraction(interaction as unknown as Interaction) };
}

function makeDisposableChannel() {
  const createdAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  return {
    id: 'daily-1',
    type: ChannelType.GuildText,
    guildId,
    parentId: categoryId,
    name: formatChannelName(createdAt),
    createdAt,
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

function makeForumThread() {
  const bot = { id: 'bot-1' };
  const forum = {
    id: 'forum-1',
    type: ChannelType.GuildForum,
    guildId,
    guild: { members: { me: bot } },
    permissionsFor: vi.fn().mockReturnValue({ has: () => true }),
  };
  const confirmation = {
    id: 'confirmation',
    author: bot,
    content: FORUM_CONFIRM_MARKER,
    components: [],
  };
  const history = new Collection<string, { author: { id: string }; content: string }>();
  const messages = {
    fetch: vi.fn(async (options: { message?: string }) => options.message ? confirmation : history),
  };
  const thread = {
    id: 'thread-1',
    type: ChannelType.PublicThread,
    guildId,
    parentId: forum.id,
    flags: new ChannelFlagsBitField(),
    archived: false,
    name: 'forum thread',
    messages,
    setArchived: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
  };
  return { forum, thread, confirmation, history };
}

describe('interactionHandler', () => {
  beforeEach(() => {
    setConfig(configSchema.parse({ DISCORD_TOKEN: 'test', GUILD_ID: guildId, CATEGORY_ID: categoryId }));
  });

  describe('Slash Command: daily-batch-run', () => {
    it('rejects user without ManageChannels permission', async () => {
      const mockInteraction: any = {
        isChatInputCommand: () => true,
        isButton: () => false,
        commandName: 'daily-batch-run',
        memberPermissions: {
          has: vi.fn().mockReturnValue(false),
        },
        reply: vi.fn().mockResolvedValue({}),
      };

      await handleInteraction(mockInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('「チャンネルの管理」権限が必要です'),
          ephemeral: true,
        })
      );
    });

    it('executes batch lifecycle when user has ManageChannels permission', async () => {
      const mockResult = {
        created: true,
        createdChannel: null,
        todayChannel: null,
        createdChannelName: '使い捨て会話_11月12日',
        confirmSentChannels: ['使い捨て会話_11月11日'],
        deletedChannels: ['使い捨て会話_11月05日'],
        skippedChannels: [],
        errors: [],
      };

      vi.spyOn(channelManager, 'runDailyLifecycle').mockResolvedValue(mockResult);

      const mockInteraction: any = {
        isChatInputCommand: () => true,
        isButton: () => false,
        commandName: 'daily-batch-run',
        memberPermissions: {
          has: (perm: bigint) => perm === PermissionFlagsBits.ManageChannels,
        },
        deferReply: vi.fn().mockResolvedValue({}),
        editReply: vi.fn().mockResolvedValue({}),
        client: {},
      };

      await handleInteraction(mockInteraction);

      expect(mockInteraction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('定期バッチの即時実行が完了しました'),
        })
      );
    });
  });

  describe('Buttons', () => {
    it('rejects button click if user lacks ManageChannels permission', async () => {
      const mockInteraction: any = {
        isChatInputCommand: () => false,
        isButton: () => true,
        customId: BUTTON_IDS.CONFIRM_DELETE,
        memberPermissions: {
          has: vi.fn().mockReturnValue(false),
        },
        reply: vi.fn().mockResolvedValue({}),
      };

      await handleInteraction(mockInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('「チャンネルの管理」権限が必要です'),
          ephemeral: true,
        })
      );
    });

    it('fetches and deletes the current managed channel when authorized', async () => {
      const channel = makeDisposableChannel();
      const { interaction, fetch, run } = mockButton(BUTTON_IDS.CONFIRM_DELETE, channel.id, channel);

      await run();

      expect(fetch).toHaveBeenCalledWith(channel.id, { force: true, cache: false });
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('チャンネルを削除しています') })
      );
      expect(channel.delete).toHaveBeenCalledWith(
        expect.stringContaining('ユーザー承認による使い捨てチャンネル手動削除')
      );
    });

    it('falls back to a fresh client lookup when the channel is missing in the guild lookup', async () => {
      const channel = makeDisposableChannel();
      const { interaction, run } = mockButton(BUTTON_IDS.CONFIRM_DELETE, channel.id);
      interaction.client.channels.fetch.mockResolvedValue(channel);

      await run();

      expect(interaction.client.channels.fetch).toHaveBeenCalledWith(channel.id, { force: true, cache: false });
      expect(channel.delete).toHaveBeenCalledOnce();
    });

    it.each([{ parentId: 'elsewhere' }, { name: 'renamed' }])('does not delete when the channel changed: %o', async (change) => {
      const original = makeDisposableChannel();
      const current = { ...original, ...change };
      const { interaction, run } = mockButton(BUTTON_IDS.CONFIRM_DELETE, current.id, current);
      interaction.channel = original;

      await run();

      expect(current.delete).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('削除対象の使い捨て会話ではありません') })
      );
    });

    it('handles permission denied error (50013) on channel delete', async () => {
      const channel = makeDisposableChannel();
      channel.delete.mockRejectedValue({ code: 50013, message: 'Missing Permissions' });
      const { interaction, run } = mockButton(BUTTON_IDS.CONFIRM_DELETE, channel.id, channel);

      await run();

      expect(interaction.editReply).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: expect.stringContaining('Botにこのチャンネルを削除する権限') })
      );
    });

    it('postpones deletion on cancel button when authorized', async () => {
      const mockInteraction: any = {
        isChatInputCommand: () => false,
        isButton: () => true,
        customId: BUTTON_IDS.CANCEL_DELETE,
        memberPermissions: {
          has: (perm: bigint) => perm === PermissionFlagsBits.ManageChannels,
        },
        user: { id: 'user-123' },
        update: vi.fn().mockResolvedValue({}),
      };

      await handleInteraction(mockInteraction);

      expect(mockInteraction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('チャンネルの削除は保留されました'),
          components: [],
        })
      );
    });
  });

  describe('Slash Command: test_forum_cleanup', () => {
    it('rejects user without ManageChannels permission', async () => {
      const mockInteraction: any = {
        isChatInputCommand: () => true,
        isButton: () => false,
        commandName: 'test_forum_cleanup',
        memberPermissions: {
          has: vi.fn().mockReturnValue(false),
        },
        reply: vi.fn().mockResolvedValue({}),
      };

      await handleInteraction(mockInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('「チャンネルの管理」権限が必要です'),
          ephemeral: true,
        })
      );
    });

    it('runs forum cleanup with provided days and dry_run options', async () => {
      const mockForumResult = {
        inspectedForumCount: 2,
        inspectedThreadCount: 5,
        skippedPinnedCount: 1,
        skippedAlreadyConfirmedCount: 0,
        targets: [
          {
            forumId: 'f1',
            forumName: '何でも投稿bro',
            threadId: 't1',
            threadName: '古いトピック',
            lastPostDate: new Date('2026-10-01T00:00:00Z'),
            lastPostDateStr: '2026/10/01',
            elapsedDays: 42,
            alreadyConfirmed: false,
            archived: true,
          },
        ],
        confirmSentThreads: [],
        errors: [],
        dryRun: true,
        thresholdDays: 5,
      };

      const spy = vi
        .spyOn(forumManager, 'runForumCleanup')
        .mockResolvedValue(mockForumResult);

      const mockInteraction: any = {
        isChatInputCommand: () => true,
        isButton: () => false,
        commandName: 'test_forum_cleanup',
        memberPermissions: {
          has: (perm: bigint) => perm === PermissionFlagsBits.ManageChannels,
        },
        options: {
          getInteger: vi.fn().mockReturnValue(5),
          getBoolean: vi.fn().mockReturnValue(true),
        },
        deferReply: vi.fn().mockResolvedValue({}),
        editReply: vi.fn().mockResolvedValue({}),
        client: {},
      };

      await handleInteraction(mockInteraction);

      expect(spy).toHaveBeenCalledWith(mockInteraction.client, {
        days: 5,
        dryRun: true,
      });
      expect(mockInteraction.deferReply).toHaveBeenCalledWith({ ephemeral: true });
      expect(mockInteraction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('古いトピック'),
        })
      );
      spy.mockRestore();
    });
  });

  describe('Forum Buttons', () => {
    it('rejects forum delete button when user lacks ManageChannels permission', async () => {
      const mockInteraction: any = {
        isChatInputCommand: () => false,
        isButton: () => true,
        customId: FORUM_BUTTON_IDS.CONFIRM_DELETE,
        memberPermissions: {
          has: vi.fn().mockReturnValue(false),
        },
        reply: vi.fn().mockResolvedValue({}),
      };

      await handleInteraction(mockInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('「チャンネルの管理」権限が必要です'),
          ephemeral: true,
        })
      );
    });

    it('refuses deletion when the parent cannot be verified as a forum', async () => {
      const { forum, thread } = makeForumThread();
      const parent = { ...forum, type: ChannelType.GuildText };
      const { interaction, run } = mockButton(FORUM_BUTTON_IDS.CONFIRM_DELETE, thread.id, thread, parent);

      await run();

      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('フォーラムチャンネル配下のトピック内でのみ有効') })
      );
      expect(thread.delete).not.toHaveBeenCalled();
    });

    it('deletes an uncached forum thread after checking the current confirmation and replies', async () => {
      const { forum, thread } = makeForumThread();
      const { interaction, fetch, run } = mockButton(FORUM_BUTTON_IDS.CONFIRM_DELETE, thread.id, thread, forum);

      await run();

      expect(fetch.mock.calls).toEqual([
        [thread.id, { force: true, cache: false }],
        [forum.id, { force: true, cache: false }],
      ]);
      expect(thread.messages.fetch).toHaveBeenLastCalledWith({ after: 'confirmation', limit: 100, cache: false });
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('削除が承認されました') })
      );
      expect(thread.delete).toHaveBeenCalledWith(
        expect.stringContaining('長期未更新フォーラムトピック削除承認 (承認者: Moderator#0001)')
      );
    });

    it('does not delete a thread that was pinned after issuing the confirmation', async () => {
      const { forum, thread } = makeForumThread();
      const { interaction, run } = mockButton(FORUM_BUTTON_IDS.CONFIRM_DELETE, thread.id, thread, forum);
      interaction.channel = { ...thread, flags: new ChannelFlagsBitField() };
      thread.flags.add(ChannelFlags.Pinned);

      await run();

      expect(thread.delete).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('ピン留め') })
      );
    });

    it('does not delete a forum thread with new activity', async () => {
      const { forum, thread, history } = makeForumThread();
      history.set('reply', { author: { id: 'another-member' }, content: 'New activity' });
      const { interaction, run } = mockButton(FORUM_BUTTON_IDS.CONFIRM_DELETE, thread.id, thread, forum);

      await run();

      expect(thread.delete).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('削除確認後に新しい投稿') })
      );
    });

    it('does not delete when message history is unavailable', async () => {
      const { forum, thread } = makeForumThread();
      thread.messages.fetch.mockRejectedValue(new Error('Discord history lookup failed'));
      const { interaction, run } = mockButton(FORUM_BUTTON_IDS.CONFIRM_DELETE, thread.id, thread, forum);

      await run();

      expect(thread.delete).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('投稿を確認できない') })
      );
    });

    it('does not interpret empty history as inactivity when the bot lacks permission', async () => {
      const { forum, thread } = makeForumThread();
      forum.permissionsFor.mockReturnValue({ has: () => false });
      const { interaction, run } = mockButton(FORUM_BUTTON_IDS.CONFIRM_DELETE, thread.id, thread, forum);

      await run();

      expect(thread.messages.fetch).not.toHaveBeenCalled();
      expect(thread.delete).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('投稿を確認する権限がない') })
      );
    });

    it('does not delete when the original confirmation was edited to keep', async () => {
      const { forum, thread, confirmation } = makeForumThread();
      confirmation.content = FORUM_KEEP_MARKER;
      const { interaction, run } = mockButton(FORUM_BUTTON_IDS.CONFIRM_DELETE, thread.id, thread, forum);

      await run();

      expect(thread.delete).not.toHaveBeenCalled();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('現在有効な削除確認ではない') })
      );
    });

    it.each([false, true])('edits the source message to keep and preserves archive state (archived: %s)', async (archived) => {
      const { forum, thread } = makeForumThread();
      thread.archived = archived;
      const { interaction, run } = mockButton(FORUM_BUTTON_IDS.CANCEL_KEEP, thread.id, thread, forum);

      await run();

      expect(interaction.deferUpdate).toHaveBeenCalledOnce();
      expect(interaction.editReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(FORUM_KEEP_MARKER),
          components: [],
          allowedMentions: { parse: [] },
        })
      );
      expect(thread.setArchived.mock.calls.map(([value]) => value)).toEqual(archived ? [false, true] : []);
    });

    it('restores the original archive state when the keep edit fails', async () => {
      const { forum, thread } = makeForumThread();
      thread.archived = true;
      const { interaction, run } = mockButton(FORUM_BUTTON_IDS.CANCEL_KEEP, thread.id, thread, forum);
      interaction.editReply.mockRejectedValue(new Error('update failed'));

      await run();

      expect(thread.setArchived.mock.calls.map(([value]) => value)).toEqual([false, true]);
      expect(interaction.followUp).toHaveBeenCalledWith(
        expect.objectContaining({ content: expect.stringContaining('見送り処理に失敗') })
      );
    });

    it.each([false, true])('retries delete error 50083 and restores the archive on failure (fails: %s)', async (fails) => {
      const { forum, thread } = makeForumThread();
      thread.archived = true;
      thread.delete.mockRejectedValueOnce({ code: 50083, message: 'Thread is archived' });
      if (fails) {
        thread.delete.mockRejectedValueOnce(new Error('retry failed'));
      }
      const { run } = mockButton(FORUM_BUTTON_IDS.CONFIRM_DELETE, thread.id, thread, forum);

      await run();

      expect(thread.delete).toHaveBeenCalledTimes(2);
      expect(thread.setArchived.mock.calls.map(([value]) => value)).toEqual(fails ? [false, true] : [false]);
    });

    it('restores the archive and skips the retry when new activity appears while opening', async () => {
      const { forum, thread, history } = makeForumThread();
      thread.archived = true;
      thread.delete.mockRejectedValueOnce({ code: 50083, message: 'Thread is archived' });
      thread.setArchived.mockImplementationOnce(async () => {
        history.set('new-reply', { author: { id: 'another-member' }, content: 'Reopened' });
      });
      const { interaction, run } = mockButton(FORUM_BUTTON_IDS.CONFIRM_DELETE, thread.id, thread, forum);

      await run();

      expect(thread.delete).toHaveBeenCalledTimes(1);
      expect(thread.setArchived.mock.calls.map(([value]) => value)).toEqual([false, true]);
      expect(interaction.editReply).toHaveBeenLastCalledWith(
        expect.objectContaining({ content: expect.stringContaining('削除確認後に新しい投稿') })
      );
    });
  });
});
