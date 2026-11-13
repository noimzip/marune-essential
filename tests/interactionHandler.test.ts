import { describe, it, expect, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { handleInteraction } from '../src/handlers/interactionHandler.js';
import { BUTTON_IDS } from '../src/services/channelManager.js';
import * as channelManager from '../src/services/channelManager.js';
import {
  FORUM_BUTTON_IDS,
  FORUM_KEEP_MARKER,
} from '../src/services/forumManager.js';
import * as forumManager from '../src/services/forumManager.js';

describe('interactionHandler', () => {
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

    it('deletes channel on confirm button when authorized', async () => {
      const mockChannelDelete = vi.fn().mockResolvedValue({});
      const mockInteraction: any = {
        isChatInputCommand: () => false,
        isButton: () => true,
        customId: BUTTON_IDS.CONFIRM_DELETE,
        memberPermissions: {
          has: (perm: bigint) => perm === PermissionFlagsBits.ManageChannels,
        },
        channel: {
          delete: mockChannelDelete,
        },
        user: { tag: 'AdminUser#0001' },
        reply: vi.fn().mockResolvedValue({}),
      };

      await handleInteraction(mockInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('チャンネルを削除しています'),
          ephemeral: true,
        })
      );
      expect(mockChannelDelete).toHaveBeenCalledWith(
        expect.stringContaining('ユーザー承認による使い捨てチャンネル手動削除')
      );
    });

    it('fetches uncached channel by channelId and deletes it', async () => {
      const mockChannelDelete = vi.fn().mockResolvedValue({});
      const fetchedChannel = {
        id: 'ch-uncached-1',
        delete: mockChannelDelete,
      };

      const mockInteraction: any = {
        isChatInputCommand: () => false,
        isButton: () => true,
        customId: BUTTON_IDS.CONFIRM_DELETE,
        channel: null, // Uncached channel
        channelId: 'ch-uncached-1',
        guild: {
          channels: {
            fetch: vi.fn().mockResolvedValue(fetchedChannel),
          },
        },
        memberPermissions: {
          has: (perm: bigint) => perm === PermissionFlagsBits.ManageChannels,
        },
        user: { username: 'AdminUser' },
        reply: vi.fn().mockResolvedValue({}),
      };

      await handleInteraction(mockInteraction);

      expect(mockInteraction.guild.channels.fetch).toHaveBeenCalledWith('ch-uncached-1');
      expect(mockChannelDelete).toHaveBeenCalled();
    });

    it('handles permission denied error (50013) on channel delete', async () => {
      const mockChannelDelete = vi.fn().mockRejectedValue({
        code: 50013,
        message: 'Missing Permissions',
      });

      const mockInteraction: any = {
        isChatInputCommand: () => false,
        isButton: () => true,
        customId: BUTTON_IDS.CONFIRM_DELETE,
        custom_id: BUTTON_IDS.CONFIRM_DELETE,
        channel: {
          delete: mockChannelDelete,
        },
        memberPermissions: {
          has: (perm: bigint) => perm === PermissionFlagsBits.ManageChannels,
        },
        user: { username: 'AdminUser' },
        reply: vi.fn().mockResolvedValue({}),
        followUp: vi.fn().mockResolvedValue({}),
        replied: true,
      };

      await handleInteraction(mockInteraction);

      expect(mockInteraction.followUp).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('Botにこのチャンネルを削除する権限'),
          ephemeral: true,
        })
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

    it('rejects forum button outside forum threads', async () => {
      const mockInteraction: any = {
        isChatInputCommand: () => false,
        isButton: () => true,
        customId: FORUM_BUTTON_IDS.CONFIRM_DELETE,
        memberPermissions: {
          has: () => true,
        },
        channel: {
          isThread: () => false,
          type: ChannelType.GuildText,
          delete: vi.fn(),
        },
        reply: vi.fn().mockResolvedValue({}),
      };

      await handleInteraction(mockInteraction);

      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('フォーラムチャンネル配下のトピック内でのみ有効'),
          ephemeral: true,
        })
      );
      expect(mockInteraction.channel.delete).not.toHaveBeenCalled();
    });

    it('deletes uncached forum thread on confirm button when authorized', async () => {
      const mockThreadDelete = vi.fn().mockResolvedValue({});
      const fetchedThread = {
        id: 'th-uncached',
        isThread: () => true,
        parent: { type: ChannelType.GuildForum },
        delete: mockThreadDelete,
      };

      const mockInteraction: any = {
        isChatInputCommand: () => false,
        isButton: () => true,
        customId: FORUM_BUTTON_IDS.CONFIRM_DELETE,
        channel: null,
        channelId: 'th-uncached',
        guild: {
          channels: {
            fetch: vi.fn().mockResolvedValue(fetchedThread),
          },
        },
        memberPermissions: {
          has: (perm: bigint) => perm === PermissionFlagsBits.ManageChannels,
        },
        user: { tag: 'Moderator#0001' },
        reply: vi.fn().mockResolvedValue({}),
      };

      await handleInteraction(mockInteraction);

      expect(mockInteraction.guild.channels.fetch).toHaveBeenCalledWith('th-uncached');
      expect(mockInteraction.reply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining('削除が承認されました'),
          ephemeral: true,
        })
      );
      expect(mockThreadDelete).toHaveBeenCalledWith(
        expect.stringContaining('長期未更新フォーラムトピック削除承認 (承認者: Moderator#0001)')
      );
    });

    it('updates confirmation message to kept state on keep button', async () => {
      const mockInteraction: any = {
        isChatInputCommand: () => false,
        isButton: () => true,
        customId: FORUM_BUTTON_IDS.CANCEL_KEEP,
        channel: {
          isThread: () => true,
          parent: { type: ChannelType.GuildForum },
        },
        memberPermissions: {
          has: (perm: bigint) => perm === PermissionFlagsBits.ManageChannels,
        },
        user: { id: 'user-777' },
        update: vi.fn().mockResolvedValue({}),
      };

      await handleInteraction(mockInteraction);

      expect(mockInteraction.update).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(FORUM_KEEP_MARKER),
          components: [],
        })
      );
    });

    it('temporarily unarchives and re-closes an archived thread on keep button', async () => {
      const mockSetArchived = vi.fn().mockResolvedValue({});
      const mockUpdate = vi.fn().mockResolvedValue({});
      const mockInteraction: any = {
        isChatInputCommand: () => false,
        isButton: () => true,
        customId: FORUM_BUTTON_IDS.CANCEL_KEEP,
        channel: {
          isThread: () => true,
          archived: true,
          parent: { type: ChannelType.GuildForum },
          setArchived: mockSetArchived,
        },
        memberPermissions: {
          has: (perm: bigint) => perm === PermissionFlagsBits.ManageChannels,
        },
        user: { id: 'user-777' },
        update: mockUpdate,
      };

      await handleInteraction(mockInteraction);

      expect(mockSetArchived).toHaveBeenNthCalledWith(
        1,
        false,
        expect.stringContaining('一時解除')
      );
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          content: expect.stringContaining(FORUM_KEEP_MARKER),
          components: [],
          allowedMentions: { parse: [] },
        })
      );
      expect(mockSetArchived).toHaveBeenNthCalledWith(
        2,
        true,
        expect.stringContaining('再クローズ')
      );
    });

    it('unarchives and retries deletion if thread delete returns 50083 (Thread is archived)', async () => {
      const mockSetArchived = vi.fn().mockResolvedValue({});
      const mockThreadDelete = vi
        .fn()
        .mockRejectedValueOnce({ code: 50083, message: 'Thread is archived' })
        .mockResolvedValueOnce({});

      const mockInteraction: any = {
        isChatInputCommand: () => false,
        isButton: () => true,
        customId: FORUM_BUTTON_IDS.CONFIRM_DELETE,
        channel: {
          id: 'th-archived',
          isThread: () => true,
          archived: true,
          parent: { type: ChannelType.GuildForum },
          setArchived: mockSetArchived,
          delete: mockThreadDelete,
        },
        memberPermissions: {
          has: (perm: bigint) => perm === PermissionFlagsBits.ManageChannels,
        },
        user: { tag: 'Moderator#0001' },
        reply: vi.fn().mockResolvedValue({}),
      };

      await handleInteraction(mockInteraction);

      expect(mockSetArchived).toHaveBeenCalledWith(
        false,
        expect.stringContaining('アーカイブ解除')
      );
      expect(mockThreadDelete).toHaveBeenCalledTimes(2);
    });
  });
});
