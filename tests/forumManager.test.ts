import { describe, it, expect, vi } from 'vitest';
import {
  ChannelFlags,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import {
  runForumCleanupForGuild,
  FORUM_BUTTON_IDS,
  FORUM_CONFIRM_MARKER,
  FORUM_KEEP_MARKER,
} from '../src/services/forumManager.js';

function createMockCollection<K, V>(entries: Array<[K, V]>): Map<K, V> {
  return new Map(entries);
}

function makeMockMessage(opts: {
  id: string;
  createdAt: Date;
  bot?: boolean;
  authorId?: string;
  content?: string;
  customIds?: string[];
}) {
  return {
    id: opts.id,
    createdAt: opts.createdAt,
    createdTimestamp: opts.createdAt.getTime(),
    author: {
      id: opts.authorId ?? (opts.bot ? 'bot-1' : 'user-1'),
      bot: Boolean(opts.bot),
    },
    content: opts.content ?? 'hello',
    components: opts.customIds
      ? [
          {
            components: opts.customIds.map((id) => ({ customId: id })),
          },
        ]
      : [],
  };
}

describe('forumManager (runForumCleanupForGuild)', () => {
  // Reference: 2026-11-22 00:00:00 JST (2026-11-21T15:00:00Z)
  const refDate = new Date('2026-11-21T15:00:00Z');
  const daysAgo = (n: number) =>
    new Date(refDate.getTime() - n * 24 * 60 * 60 * 1000 + 60 * 60 * 1000); // +1h JST inside that day

  it('detects 21+ day inactive threads across active and paginated archived, skips pinned and excluded', async () => {
    const mockSendActiveOld = vi.fn().mockResolvedValue({});
    const mockSetArchivedActive = vi.fn().mockResolvedValue({});
    const mockSendArchivedOld = vi.fn().mockResolvedValue({});
    const mockSetArchived = vi.fn().mockResolvedValue({});
    const mockSendRecent = vi.fn().mockResolvedValue({});
    const mockSendPinned = vi.fn().mockResolvedValue({});

    // Active thread: 22 days inactive -> should send confirm and close thread
    const activeOldThread: any = {
      id: 'th-active-old',
      name: 'old-active-topic',
      parentId: 'forum-1',
      archived: false,
      createdAt: daysAgo(30),
      flags: { has: (f: number) => false },
      messages: {
        fetch: vi.fn().mockResolvedValue(
          createMockCollection([
            ['m1', makeMockMessage({ id: 'm1', createdAt: daysAgo(22) })],
          ])
        ),
      },
      setArchived: mockSetArchivedActive,
      send: mockSendActiveOld,
    };

    // Active thread: pinned & 40 days inactive -> should skip
    const pinnedThread: any = {
      id: 'th-pinned',
      name: 'rules-pinned',
      parentId: 'forum-1',
      archived: false,
      createdAt: daysAgo(40),
      flags: { has: (f: number) => f === ChannelFlags.Pinned },
      messages: { fetch: vi.fn() },
      send: mockSendPinned,
    };

    // Archived page 1: recent (10 days inactive) -> should skip
    const archivedRecentThread: any = {
      id: 'th-arch-recent',
      name: 'recent-archived',
      parentId: 'forum-1',
      archived: true,
      archivedAt: daysAgo(5),
      createdAt: daysAgo(15),
      flags: { has: () => false },
      messages: {
        fetch: vi.fn().mockResolvedValue(
          createMockCollection([
            ['m2', makeMockMessage({ id: 'm2', createdAt: daysAgo(10) })],
          ])
        ),
      },
      send: mockSendRecent,
    };

    // Archived page 2: 25 days inactive, empty messages (falls back to createdAt) -> should unarchive & send
    const archivedOldEmptyThread: any = {
      id: 'th-arch-old',
      name: 'old-archived-no-msgs',
      parentId: 'forum-1',
      archived: true,
      archivedAt: daysAgo(20),
      createdAt: daysAgo(25),
      flags: { has: () => false },
      messages: {
        fetch: vi.fn().mockResolvedValue(createMockCollection([])),
      },
      setArchived: mockSetArchived,
      send: mockSendArchivedOld,
    };

    const fetchArchived = vi
      .fn()
      .mockResolvedValueOnce({
        threads: createMockCollection([['th-arch-recent', archivedRecentThread]]),
        hasMore: true,
      })
      .mockResolvedValueOnce({
        threads: createMockCollection([['th-arch-old', archivedOldEmptyThread]]),
        hasMore: false,
      });

    const forum1: any = {
      id: 'forum-1',
      name: '何でも投稿bro',
      type: ChannelType.GuildForum,
      permissionsFor: vi.fn().mockReturnValue({
        has: () => true,
      }),
      threads: {
        fetchArchived,
      },
    };

    const excludedForum: any = {
      id: 'forum-excluded',
      name: 'excluded-forum',
      type: ChannelType.GuildForum,
      permissionsFor: vi.fn().mockReturnValue({ has: () => true }),
      threads: {
        fetchArchived: vi.fn(),
      },
    };

    const textChannel: any = {
      id: 'text-1',
      name: 'general',
      type: ChannelType.GuildText,
    };

    const mockGuild: any = {
      id: 'guild-1',
      name: 'Test Guild',
      members: {
        me: {
          id: 'bot-1',
        },
      },
      channels: {
        fetch: vi.fn().mockResolvedValue(
          createMockCollection<string, any>([
            ['forum-1', forum1],
            ['forum-excluded', excludedForum],
            ['text-1', textChannel],
          ])
        ),
        fetchActiveThreads: vi.fn().mockResolvedValue({
          threads: createMockCollection([
            ['th-active-old', activeOldThread],
            ['th-pinned', pinnedThread],
          ]),
        }),
      },
    };

    const result = await runForumCleanupForGuild(mockGuild, {
      days: 21,
      dryRun: false,
      excludedForumIds: ['forum-excluded'],
      referenceDate: refDate,
      actionDelayMs: 0,
    });

    expect(result.inspectedForumCount).toBe(1);
    expect(result.inspectedThreadCount).toBe(4);
    expect(result.skippedPinnedCount).toBe(1);
    expect(excludedForum.threads.fetchArchived).not.toHaveBeenCalled();

    // Pagination check
    expect(fetchArchived).toHaveBeenCalledTimes(2);
    expect(fetchArchived).toHaveBeenNthCalledWith(2, {
      type: 'public',
      limit: 100,
      before: archivedRecentThread.archivedAt,
    });

    // Confirm sent to activeOldThread & archivedOldEmptyThread
    expect(result.confirmSentThreads.map((t) => t.threadId)).toEqual([
      'th-active-old',
      'th-arch-old',
    ]);
    expect(mockSetArchived).toHaveBeenNthCalledWith(
      1,
      false,
      expect.stringContaining('アーカイブ一時解除')
    );
    expect(mockSetArchived).toHaveBeenNthCalledWith(
      2,
      true,
      expect.stringContaining('自動クローズ')
    );
    expect(mockSetArchivedActive).toHaveBeenCalledWith(
      true,
      expect.stringContaining('自動クローズ')
    );
    expect(mockSendActiveOld).toHaveBeenCalledTimes(1);
    expect(mockSendArchivedOld).toHaveBeenCalledTimes(1);
    expect(mockSendPinned).not.toHaveBeenCalled();
    expect(mockSendRecent).not.toHaveBeenCalled();

    // Verify buttons, silent flags & content
    const sendArg = mockSendActiveOld.mock.calls[0][0];
    expect(sendArg.flags).toEqual([MessageFlags.SuppressNotifications]);
    expect(sendArg.content).toContain(FORUM_CONFIRM_MARKER);
    expect(sendArg.content).toContain('22日経過');
    expect(sendArg.components[0].components[0].data.custom_id).toBe(
      FORUM_BUTTON_IDS.CONFIRM_DELETE
    );
    expect(sendArg.components[0].components[1].data.custom_id).toBe(
      FORUM_BUTTON_IDS.CANCEL_KEEP
    );
  });

  it('ignores bot confirmation message when computing last post date and prevents duplicate confirmation', async () => {
    const mockSend = vi.fn().mockResolvedValue({});

    const threadAlreadyConfirmed: any = {
      id: 'th-confirmed',
      name: 'already-confirmed',
      parentId: 'forum-1',
      archived: false,
      createdAt: daysAgo(40),
      flags: { has: () => false },
      messages: {
        fetch: vi.fn().mockResolvedValue(
          createMockCollection([
            // Bot sent confirmation yesterday (1 day ago)
            [
              'm-bot',
              makeMockMessage({
                id: 'm-bot',
                createdAt: daysAgo(1),
                bot: true,
                authorId: 'bot-1',
                content: `${FORUM_CONFIRM_MARKER}\n...`,
                customIds: [FORUM_BUTTON_IDS.CONFIRM_DELETE, FORUM_BUTTON_IDS.CANCEL_KEEP],
              }),
            ],
            // Last human post was 25 days ago
            [
              'm-human',
              makeMockMessage({
                id: 'm-human',
                createdAt: daysAgo(25),
              }),
            ],
          ])
        ),
      },
      send: mockSend,
    };

    const forum1: any = {
      id: 'forum-1',
      name: 'forum-1',
      type: ChannelType.GuildForum,
      permissionsFor: vi.fn().mockReturnValue({ has: () => true }),
      threads: {
        fetchArchived: vi.fn().mockResolvedValue({ threads: new Map(), hasMore: false }),
      },
    };

    const mockGuild: any = {
      id: 'guild-1',
      members: { me: { id: 'bot-1' } },
      channels: {
        fetch: vi.fn().mockResolvedValue(createMockCollection([['forum-1', forum1]])),
        fetchActiveThreads: vi.fn().mockResolvedValue({
          threads: createMockCollection([['th-confirmed', threadAlreadyConfirmed]]),
        }),
      },
    };

    const result = await runForumCleanupForGuild(mockGuild, {
      days: 21,
      dryRun: false,
      referenceDate: refDate,
      actionDelayMs: 0,
    });

    // Should be detected as 25 days inactive (not 1 day!), and skipped from sending duplicate
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].elapsedDays).toBe(25);
    expect(result.targets[0].alreadyConfirmed).toBe(true);
    expect(result.skippedAlreadyConfirmedCount).toBe(1);
    expect(result.confirmSentThreads).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('respects keep grace period and resumes notifying after thresholdDays pass since keep', async () => {
    const mockSend = vi.fn().mockResolvedValue({});

    // Kept 5 days ago, last human post 30 days ago -> should skip
    const keptRecentlyThread: any = {
      id: 'th-kept-recent',
      name: 'kept-recent',
      parentId: 'forum-1',
      archived: false,
      createdAt: daysAgo(40),
      flags: { has: () => false },
      messages: {
        fetch: vi.fn().mockResolvedValue(
          createMockCollection([
            [
              'm-keep',
              makeMockMessage({
                id: 'm-keep',
                createdAt: daysAgo(5),
                bot: true,
                authorId: 'bot-1',
                content: `${FORUM_KEEP_MARKER}（承認者: <@u1>）`,
              }),
            ],
            ['m-human', makeMockMessage({ id: 'm-human', createdAt: daysAgo(30) })],
          ])
        ),
      },
      send: mockSend,
    };

    // Kept 22 days ago, last human post 45 days ago -> grace period expired -> should send again
    const keptExpiredThread: any = {
      id: 'th-kept-expired',
      name: 'kept-expired',
      parentId: 'forum-1',
      archived: false,
      createdAt: daysAgo(50),
      flags: { has: () => false },
      messages: {
        fetch: vi.fn().mockResolvedValue(
          createMockCollection([
            [
              'm-keep-old',
              makeMockMessage({
                id: 'm-keep-old',
                createdAt: daysAgo(22),
                bot: true,
                authorId: 'bot-1',
                content: `${FORUM_KEEP_MARKER}（承認者: <@u1>）`,
              }),
            ],
            ['m-human-old', makeMockMessage({ id: 'm-human-old', createdAt: daysAgo(45) })],
          ])
        ),
      },
      send: mockSend,
    };

    const forum1: any = {
      id: 'forum-1',
      name: 'forum-1',
      type: ChannelType.GuildForum,
      permissionsFor: vi.fn().mockReturnValue({ has: () => true }),
      threads: {
        fetchArchived: vi.fn().mockResolvedValue({ threads: new Map(), hasMore: false }),
      },
    };

    const mockGuild: any = {
      id: 'guild-1',
      members: { me: { id: 'bot-1' } },
      channels: {
        fetch: vi.fn().mockResolvedValue(createMockCollection([['forum-1', forum1]])),
        fetchActiveThreads: vi.fn().mockResolvedValue({
          threads: createMockCollection([
            ['th-kept-recent', keptRecentlyThread],
            ['th-kept-expired', keptExpiredThread],
          ]),
        }),
      },
    };

    const result = await runForumCleanupForGuild(mockGuild, {
      days: 21,
      dryRun: false,
      referenceDate: refDate,
      actionDelayMs: 0,
    });

    expect(result.skippedAlreadyConfirmedCount).toBe(1);
    expect(result.confirmSentThreads.map((t) => t.threadId)).toEqual(['th-kept-expired']);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('does not send messages or unarchive threads when dryRun is true', async () => {
    const mockSend = vi.fn();
    const mockSetArchived = vi.fn();

    const oldThread: any = {
      id: 'th-1',
      name: 'dryrun-topic',
      parentId: 'forum-1',
      archived: true,
      createdAt: daysAgo(25),
      flags: { has: () => false },
      messages: {
        fetch: vi.fn().mockResolvedValue(
          createMockCollection([
            ['m1', makeMockMessage({ id: 'm1', createdAt: daysAgo(25) })],
          ])
        ),
      },
      setArchived: mockSetArchived,
      send: mockSend,
    };

    const forum1: any = {
      id: 'forum-1',
      name: 'forum-1',
      type: ChannelType.GuildForum,
      permissionsFor: vi.fn().mockReturnValue({ has: () => true }),
      threads: {
        fetchArchived: vi.fn().mockResolvedValue({
          threads: createMockCollection([['th-1', oldThread]]),
          hasMore: false,
        }),
      },
    };

    const mockGuild: any = {
      id: 'guild-1',
      members: { me: { id: 'bot-1' } },
      channels: {
        fetch: vi.fn().mockResolvedValue(createMockCollection([['forum-1', forum1]])),
        fetchActiveThreads: vi.fn().mockResolvedValue({ threads: new Map() }),
      },
    };

    const result = await runForumCleanupForGuild(mockGuild, {
      days: 21,
      dryRun: true,
      referenceDate: refDate,
      actionDelayMs: 0,
    });

    expect(result.dryRun).toBe(true);
    expect(result.targets).toHaveLength(1);
    expect(result.targets[0].threadName).toBe('dryrun-topic');
    expect(result.confirmSentThreads).toHaveLength(0);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockSetArchived).not.toHaveBeenCalled();
  });

  it('records error and continues when a forum lacks required permissions', async () => {
    const forumNoPerm: any = {
      id: 'forum-noperm',
      name: 'locked-forum',
      type: ChannelType.GuildForum,
      permissionsFor: vi.fn().mockReturnValue({
        has: (perm: bigint) => perm !== PermissionFlagsBits.ManageThreads,
      }),
      threads: { fetchArchived: vi.fn() },
    };

    const mockGuild: any = {
      id: 'guild-1',
      members: { me: { id: 'bot-1' } },
      channels: {
        fetch: vi.fn().mockResolvedValue(createMockCollection([['forum-noperm', forumNoPerm]])),
        fetchActiveThreads: vi.fn().mockResolvedValue({ threads: new Map() }),
      },
    };

    const result = await runForumCleanupForGuild(mockGuild, {
      days: 21,
      dryRun: true,
      referenceDate: refDate,
      actionDelayMs: 0,
    });

    expect(result.inspectedForumCount).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('locked-forum');
    expect(forumNoPerm.threads.fetchArchived).not.toHaveBeenCalled();
  });
});
