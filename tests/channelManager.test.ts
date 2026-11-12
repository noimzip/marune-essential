import { describe, it, expect, vi } from 'vitest';
import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { runLifecycleForGuild, BUTTON_IDS } from '../src/services/channelManager.js';

describe('channelManager (runLifecycleForGuild)', () => {
  const categoryId = 'cat-123';
  const refDate = new Date('2026-11-12T03:00:00Z'); // 2026-11-12 12:00:00 JST -> 使い捨て会話_11月12日

  it('throws error if bot lacks ManageChannels permission', async () => {
    const mockGuild: any = {
      name: 'Test Guild',
      id: 'guild-1',
      members: {
        me: {
          permissions: {
            has: vi.fn().mockReturnValue(false),
          },
        },
      },
    };

    await expect(runLifecycleForGuild(mockGuild, categoryId, refDate)).rejects.toThrow(
      /Bot lacks 'Manage Channels' permission/
    );
  });

  it('throws error if category is not found or not a GuildCategory', async () => {
    const mockGuild: any = {
      name: 'Test Guild',
      id: 'guild-1',
      members: {
        me: {
          permissions: {
            has: vi.fn().mockReturnValue(true),
          },
        },
      },
      channels: {
        fetch: vi.fn().mockResolvedValue(new Map()),
      },
    };

    await expect(runLifecycleForGuild(mockGuild, categoryId, refDate)).rejects.toThrow(
      /Target category 'cat-123' not found/
    );
  });

  it('creates today channel, sends confirm to 1-6 day channels, and deletes 7+ day channels', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    const mockDelete = vi.fn().mockResolvedValue({});
    const mockChannelCreate = vi.fn().mockResolvedValue({
      name: '使い捨て会話_11月12日',
      send: mockSend,
    });

    const categoryChannel = {
      id: categoryId,
      type: ChannelType.GuildCategory,
    };

    const pastChannel1Day = {
      id: 'ch-1',
      name: '使い捨て会話_11月11日', // 1 day ago
      parentId: categoryId,
      type: ChannelType.GuildText,
      send: mockSend,
      delete: mockDelete,
    };

    const pastChannel3Days = {
      id: 'ch-3',
      name: '使い捨て会話_11月09日', // 3 days ago
      parentId: categoryId,
      type: ChannelType.GuildText,
      send: mockSend,
      delete: mockDelete,
    };

    const pastChannel7Days = {
      id: 'ch-7',
      name: '使い捨て会話_11月05日', // 7 days ago
      parentId: categoryId,
      type: ChannelType.GuildText,
      send: mockSend,
      delete: mockDelete,
    };

    const pastChannel10Days = {
      id: 'ch-10',
      name: '使い捨て会話_11月02日', // 10 days ago
      parentId: categoryId,
      type: ChannelType.GuildText,
      send: mockSend,
      delete: mockDelete,
    };

    const unrelatedChannel = {
      id: 'ch-other',
      name: 'general-chat',
      parentId: categoryId,
      type: ChannelType.GuildText,
      send: mockSend,
      delete: mockDelete,
    };

    const channelsMap = new Map<string, any>([
      [categoryId, categoryChannel],
      ['ch-1', pastChannel1Day],
      ['ch-3', pastChannel3Days],
      ['ch-7', pastChannel7Days],
      ['ch-10', pastChannel10Days],
      ['ch-other', unrelatedChannel],
    ]);

    const mockGuild: any = {
      name: 'Test Guild',
      id: 'guild-1',
      members: {
        me: {
          permissions: {
            has: (perm: bigint) => perm === PermissionFlagsBits.ManageChannels,
          },
        },
      },
      channels: {
        fetch: vi.fn().mockResolvedValue(channelsMap),
        create: mockChannelCreate,
      },
    };

    const result = await runLifecycleForGuild(mockGuild, categoryId, refDate);

    // 1. Created today channel
    expect(result.created).toBe(true);
    expect(result.createdChannelName).toBe('使い捨て会話_11月12日');
    expect(mockChannelCreate).toHaveBeenCalledWith({
      name: '使い捨て会話_11月12日',
      type: ChannelType.GuildText,
      parent: categoryId,
      reason: '毎日0:00の使い捨て会話チャンネル自動生成',
    });

    // 2. Sent deletion confirmation to 1-day and 3-day old channels
    expect(result.confirmSentChannels).toEqual([
      '使い捨て会話_11月11日',
      '使い捨て会話_11月09日',
    ]);
    expect(mockSend).toHaveBeenCalledTimes(3); // 1 for new welcome msg + 2 for confirm prompts

    // Verify confirmation message buttons
    const confirmCallArgs = mockSend.mock.calls[1][0];
    expect(confirmCallArgs.components[0].components[0].data.custom_id).toBe(
      BUTTON_IDS.CONFIRM_DELETE
    );
    expect(confirmCallArgs.components[0].components[1].data.custom_id).toBe(
      BUTTON_IDS.CANCEL_DELETE
    );

    // 3. Deleted 7-day and 10-day old channels
    expect(result.deletedChannels).toEqual([
      '使い捨て会話_11月05日',
      '使い捨て会話_11月02日',
    ]);
    expect(mockDelete).toHaveBeenCalledTimes(2);

    // 4. Skipped unrelated channel
    expect(result.skippedChannels).toContain('general-chat');
  });

  it('skips channel creation if today channel already exists', async () => {
    const mockSend = vi.fn().mockResolvedValue({});
    const mockChannelCreate = vi.fn();

    const categoryChannel = {
      id: categoryId,
      type: ChannelType.GuildCategory,
    };

    const todayChannel = {
      id: 'ch-today',
      name: '使い捨て会話_11月12日',
      parentId: categoryId,
      type: ChannelType.GuildText,
      send: mockSend,
    };

    const channelsMap = new Map<string, any>([
      [categoryId, categoryChannel],
      ['ch-today', todayChannel],
    ]);

    const mockGuild: any = {
      name: 'Test Guild',
      id: 'guild-1',
      members: {
        me: {
          permissions: {
            has: () => true,
          },
        },
      },
      channels: {
        fetch: vi.fn().mockResolvedValue(channelsMap),
        create: mockChannelCreate,
      },
    };

    const result = await runLifecycleForGuild(mockGuild, categoryId, refDate);

    expect(result.created).toBe(false);
    expect(result.createdChannelName).toBe('使い捨て会話_11月12日');
    expect(mockChannelCreate).not.toHaveBeenCalled();
    expect(result.skippedChannels).toContain('使い捨て会話_11月12日');
  });
});
