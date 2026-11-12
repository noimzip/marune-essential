import { describe, it, expect, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { handleInteraction } from '../src/handlers/interactionHandler.js';
import { BUTTON_IDS } from '../src/services/channelManager.js';
import * as channelManager from '../src/services/channelManager.js';

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
});
