import { describe, it, expect, vi } from 'vitest';
import { ChannelType, Collection, MessageFlags, PermissionFlagsBits, type Guild, type MessageCreateOptions } from 'discord.js';
import { runLifecycleForGuild, BUTTON_IDS } from '../src/services/channelManager.js';

const emptyHistory = () => ({
  permissionsFor: () => ({ has: (perm: bigint) => perm === PermissionFlagsBits.ReadMessageHistory }),
  messages: { fetch: vi.fn().mockResolvedValue(new Collection()) },
});

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

  it('throws error if bot lacks ManageChannels permission in the target category', async () => {
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
        fetch: vi.fn().mockResolvedValue(
          new Map([
            [
              categoryId,
              {
                id: categoryId,
                name: 'テキストチャンネル',
                type: ChannelType.GuildCategory,
                permissionsFor: vi.fn().mockReturnValue({
                  has: vi.fn().mockReturnValue(false),
                }),
              },
            ],
          ])
        ),
      },
    };

    await expect(runLifecycleForGuild(mockGuild, categoryId, refDate)).rejects.toThrow(
      /Bot lacks 'Manage Channels' permission in category 'テキストチャンネル'/
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
      ...emptyHistory(),
    };

    const pastChannel3Days = {
      id: 'ch-3',
      name: '使い捨て会話_11月09日', // 3 days ago
      parentId: categoryId,
      type: ChannelType.GuildText,
      send: mockSend,
      delete: mockDelete,
      ...emptyHistory(),
    };

    const pastChannel7Days = {
      id: 'ch-7',
      name: '使い捨て会話_11月05日', // 7 days ago
      parentId: categoryId,
      type: ChannelType.GuildText,
      createdAt: new Date('2026-11-05T00:00:00+09:00'),
      send: mockSend,
      delete: mockDelete,
    };

    const pastChannel10Days = {
      id: 'ch-10',
      name: '使い捨て会話_11月02日', // 10 days ago
      parentId: categoryId,
      type: ChannelType.GuildText,
      createdAt: new Date('2026-11-02T00:00:00+09:00'),
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
          id: 'bot',
          permissions: {
            has: (perm: bigint) => perm === PermissionFlagsBits.ManageChannels,
          },
        },
      },
      channels: {
        fetch: vi.fn(async (id?: string) => id ? channelsMap.get(id) ?? null : channelsMap),
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

    // Verify welcome & confirmation messages suppress notifications
    expect(mockSend.mock.calls[0][0].flags).toEqual([MessageFlags.SuppressNotifications]);

    // Verify confirmation message buttons
    const confirmCallArgs = mockSend.mock.calls[1][0];
    expect(confirmCallArgs.flags).toEqual([MessageFlags.SuppressNotifications]);
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

  it('skips old channels moved, renamed, changed or unavailable since the snapshot and deletes a fresh match', async () => {
    const oldChannel = (id: string) => ({
      id,
      name: '使い捨て会話_11月04日',
      parentId: categoryId,
      type: ChannelType.GuildText,
      createdAt: new Date('2026-11-04T00:00:00+09:00'),
      delete: vi.fn(),
    });
    const moved = oldChannel('moved');
    const renamed = oldChannel('renamed');
    const repurposed = oldChannel('repurposed');
    const missing = oldChannel('missing');
    const alreadyDeleted = oldChannel('already-deleted');
    const failed = oldChannel('failed');
    const forbidden = oldChannel('forbidden');
    const unchanged = oldChannel('unchanged');
    const candidates = [moved, renamed, repurposed, missing, alreadyDeleted, failed, forbidden, unchanged];
    const snapshot = new Map<string, object>([
      [categoryId, { type: ChannelType.GuildCategory }],
      ...candidates.map((channel): [string, object] => [channel.id, channel]),
    ]);
    const refreshed = new Map<string, object>();
    const current = { ...unchanged, name: '使い捨て会話-11月5日', delete: vi.fn() };
    const forbiddenDelete = vi.fn().mockRejectedValue({ code: 50013 });
    const fetch = vi.fn(async (id?: string) => {
      if (!id) return snapshot;
      if (id === failed.id) throw new Error('Discord connection failed');
      if (id === alreadyDeleted.id) throw { code: 10003 };
      return refreshed.get(id) ?? null;
    });
    const guild = {
      id: 'fresh-delete-test',
      members: { me: { permissions: { has: () => true } } },
      channels: {
        fetch,
        create: vi.fn().mockResolvedValue({
          send: async () => {
            refreshed.set(moved.id, { ...moved, parentId: 'outside' });
            refreshed.set(renamed.id, { ...renamed, name: '使い捨て会話_11月10日' });
            refreshed.set(repurposed.id, { ...repurposed, type: ChannelType.GuildAnnouncement });
            refreshed.set(forbidden.id, { ...forbidden, delete: forbiddenDelete });
            refreshed.set(unchanged.id, current);
          },
        }),
      },
    };

    const result = await runLifecycleForGuild(guild as unknown as Guild, categoryId, refDate);

    for (const channel of candidates) {
      expect(fetch).toHaveBeenCalledWith(channel.id, { force: true });
      expect(channel.delete).not.toHaveBeenCalled();
    }
    expect(forbiddenDelete).toHaveBeenCalledOnce();
    expect(current.delete).toHaveBeenCalledExactlyOnceWith('作成から7日経過による自動削除 (7日経過)');
    expect(result.deletedChannels).toEqual([current.name]);
    expect(result.skippedChannels).toHaveLength(7);
    expect(result.errors).toEqual([
      expect.stringContaining('Discord connection failed'),
      expect.stringContaining('the bot lacks permission'),
    ]);
  });

  describe('deletion confirmation history', () => {
    interface HistoryMessage {
      id: string;
      author: { id: string };
      createdTimestamp: number;
      content: string;
    }

    function makeHistoryFixture() {
      const messages = new Collection<string, HistoryMessage>();
      const readHistory = vi.fn(async (_options: { before?: string }) => messages);
      const canReadHistory = vi.fn(() => true);
      const channel = {
        id: 'past',
        name: '使い捨て会話_11月11日',
        parentId: categoryId,
        type: ChannelType.GuildText,
        createdAt: new Date('2026-11-11T00:00:00+09:00'),
        permissionsFor: () => ({ has: canReadHistory }),
        messages: { fetch: readHistory },
        send: vi.fn<(message: MessageCreateOptions) => Promise<void>>(async ({ content }) => {
          messages.set('notice', {
            id: 'notice', author: { id: 'bot' }, createdTimestamp: refDate.getTime(), content: content ?? '',
          });
        }),
      };
      const guild = {
        id: 'confirmation-history-test',
        members: { me: { id: 'bot', permissions: { has: () => true } } },
        channels: {
          fetch: vi.fn().mockResolvedValue(new Map<string, object>([
            [categoryId, { type: ChannelType.GuildCategory }],
            [channel.id, channel],
          ])),
          create: vi.fn().mockResolvedValue({ send: vi.fn() }),
        },
      } as unknown as Guild;
      return { guild, channel, messages, readHistory, canReadHistory };
    }

    it('retries a failed send on the same day and sends another confirmation on the next JST day', async () => {
      const { guild, channel } = makeHistoryFixture();
      channel.send.mockRejectedValueOnce(new Error('temporary send failure'));
      const failed = await runLifecycleForGuild(guild, categoryId, refDate);
      expect(failed.confirmSentChannels).toEqual([]);
      expect(failed.errors).toEqual([expect.stringContaining('temporary send failure')]);

      const retried = await runLifecycleForGuild(guild, categoryId, refDate);
      expect(retried.confirmSentChannels).toEqual([channel.name]);

      const nextJSTDay = new Date('2026-11-12T15:00:00Z');
      const next = await runLifecycleForGuild(guild, categoryId, nextJSTDay);
      expect(next.confirmSentChannels).toEqual([channel.name]);
      expect(channel.send).toHaveBeenCalledTimes(3);
      expect(channel.send).toHaveBeenLastCalledWith(expect.objectContaining({ content: expect.stringContaining('**2日**') }));
    });

    it('paginates recent posts to find an existing bot confirmation from today', async () => {
      const { guild, channel, messages, readHistory } = makeHistoryFixture();
      const currentDay = new Date('2026-11-11T15:00:00Z');
      const heading = '⚠️ **【使い捨てチャンネル削除確認】**';
      const newMessages = new Collection<string, HistoryMessage>();
      for (let id = 201; id >= 102; id -= 1) {
        newMessages.set(String(id), {
          id: String(id), author: { id: 'member' }, createdTimestamp: refDate.getTime(), content: heading,
        });
      }
      messages.set('101', { id: '101', author: { id: 'bot' }, createdTimestamp: currentDay.getTime(), content: heading });
      readHistory.mockResolvedValueOnce(newMessages);

      const result = await runLifecycleForGuild(guild, categoryId, refDate);

      expect(readHistory).toHaveBeenNthCalledWith(2, { before: '102', limit: 100, cache: false });
      expect(result.confirmSentChannels).toEqual([]);
      expect(result.skippedChannels).toContain(channel.name);
      expect(channel.send).not.toHaveBeenCalled();
    });

    it('reports inaccessible history and avoids an unverified duplicate send', async () => {
      const { guild, channel, readHistory, canReadHistory } = makeHistoryFixture();
      canReadHistory.mockReturnValue(false);

      const result = await runLifecycleForGuild(guild, categoryId, refDate);

      expect(result.errors).toEqual([expect.stringContaining('Read Message History')]);
      expect(readHistory).not.toHaveBeenCalled();
      expect(channel.send).not.toHaveBeenCalled();
    });
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

  describe('JST channel identity', () => {
    const reference = new Date('2026-02-09T00:00:00+09:00');

    function makeChannel(id: string, name: string, createdAt: Date, topic?: string) {
      return {
        id,
        name,
        createdAt,
        topic,
        parentId: categoryId,
        type: ChannelType.GuildText,
        send: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      };
    }

    function makeGuild(...channels: ReturnType<typeof makeChannel>[]) {
      const createdChannel = makeChannel('new', '使い捨て会話_02月09日', reference);
      const guild = {
        id: 'date-test-guild',
        members: { me: { permissions: { has: () => true } } },
        channels: {
          fetch: vi.fn(async (id?: string) => id ? channels.find((channel) => channel.id === id) ?? null
            : new Map<string, object>([
              [categoryId, { id: categoryId, type: ChannelType.GuildCategory }],
              ...channels.map((channel): [string, object] => [channel.id, channel]),
            ])),
          create: vi.fn().mockResolvedValue(createdChannel),
        },
      };
      return { guild, createdChannel };
    }

    it('recognizes the existing current channel with a hyphen and unpadded date', async () => {
      const channel = makeChannel('current', '使い捨て会話-2月9日', reference);
      const { guild } = makeGuild(channel);

      const result = await runLifecycleForGuild(guild as unknown as Guild, categoryId, reference);

      expect(result.created).toBe(false);
      expect(result.todayChannel).toBe(channel);
      expect(guild.channels.create).not.toHaveBeenCalled();
      expect(channel.delete).not.toHaveBeenCalled();
    });

    it('creates today before deleting an identically named channel from last year', async () => {
      const channel = makeChannel('old', '使い捨て会話_02月09日', new Date('2025-02-09T00:00:00+09:00'));
      const { guild, createdChannel } = makeGuild(channel);

      const result = await runLifecycleForGuild(guild as unknown as Guild, categoryId, reference, {
        createTopic: 'scheduled-post',
      });

      expect(result.created).toBe(true);
      expect(result.todayChannel).toBe(createdChannel);
      expect(guild.channels.create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        topic: 'scheduled-post',
      }));
      expect(channel.delete).toHaveBeenCalledOnce();
    });

    it('returns the existing channel with the requested topic when today has multiple channels', async () => {
      const manual = makeChannel('manual', '使い捨て会話_02月09日', reference, 'manual topic');
      const scheduled = makeChannel('scheduled', '使い捨て会話-2月9日', reference, 'scheduled-post');
      const { guild } = makeGuild(manual, scheduled);

      const result = await runLifecycleForGuild(guild as unknown as Guild, categoryId, reference, {
        createTopic: 'scheduled-post',
      });

      expect(result.todayChannel).toBe(scheduled);
      expect(guild.channels.create).not.toHaveBeenCalled();
    });

    it('skips both confirmation and automated deletion for February 30', async () => {
      const channel = makeChannel('invalid', '使い捨て会話_02月30日', reference);
      const { guild } = makeGuild(channel);

      await runLifecycleForGuild(
        guild as unknown as Guild, categoryId, new Date('2026-03-20T00:00:00+09:00')
      );

      expect(channel.send).not.toHaveBeenCalled();
      expect(channel.delete).not.toHaveBeenCalled();
    });
  });
});
