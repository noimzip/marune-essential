import { ChannelType, MessageFlags, type Client, type Interaction } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setConfig, configSchema } from '../src/config.js';
import { handleInteraction } from '../src/handlers/interactionHandler.js';
import { startDailyScheduler } from '../src/scheduler.js';
import { formatAssignmentMessage } from '../src/services/assignmentMessages.js';
import { runForumCleanup } from '../src/services/forumManager.js';
import { getUpcomingAssignments, WebClassError } from '../src/services/webClass.js';

vi.mock('../src/services/forumManager.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/forumManager.js')>(),
  runForumCleanup: vi.fn(),
}));
vi.mock('../src/services/webClass.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/webClass.js')>(),
  getUpcomingAssignments: vi.fn(),
}));

const midnight = new Date('2026-11-19T00:00:00+09:00');
const assignments = [
  { course: '論理回路Ⅰ', title: '演習問題', deadline: Date.parse('2026-11-20T17:45:59+09:00') },
  { course: 'プログラミングⅠ', title: '第6回 課題提出', deadline: Date.parse('2026-11-25T09:00:59+09:00') },
];
const firstRow = '1. 論理回路Ⅰ ｜ 演習問題 ｜ 2026-11-20 17:45';
const secondRow = '2. プログラミングⅠ ｜ 第6回 課題提出 ｜ 2026-11-25 09:00';

function mockInteraction(id: string) {
  const interaction = {
    user: { id },
    isChatInputCommand: () => true,
    commandName: 'kadai',
    deferReply: vi.fn(),
    reply: vi.fn(),
    editReply: vi.fn(),
  };
  return { interaction, run: () => handleInteraction(interaction as unknown as Interaction) };
}

function mockDiscord(existingToday = false) {
  const todaySend = vi.fn();
  const pastSend = vi.fn();
  const today = {
    id: 'today',
    type: ChannelType.GuildText,
    parentId: 'category',
    name: '使い捨て会話_11月19日',
    send: todaySend,
  };
  const channels = new Map<string, object>([
    ['category', { type: ChannelType.GuildCategory }],
    ['past', {
      type: ChannelType.GuildText, parentId: 'category', name: '使い捨て会話_11月18日', send: pastSend,
    }],
  ]);
  if (existingToday) channels.set(today.id, today);
  const create = vi.fn().mockResolvedValue(today);
  const client = {
    guilds: {
      fetch: async () => ({
        members: { me: { permissions: { has: () => true } } },
        channels: { fetch: async () => channels, create },
      }),
    },
  } as unknown as Client;
  return { client, create, todaySend, pastSend };
}

beforeEach(() => {
  setConfig(configSchema.parse({ DISCORD_TOKEN: 'test', GUILD_ID: 'guild', CATEGORY_ID: 'category' }));
  vi.mocked(getUpcomingAssignments).mockResolvedValue(assignments);
  vi.mocked(runForumCleanup).mockResolvedValue({
    inspectedForumCount: 0,
    inspectedThreadCount: 0,
    skippedPinnedCount: 0,
    skippedAlreadyConfirmedCount: 0,
    targets: [],
    confirmSentThreads: [],
    errors: [],
    dryRun: false,
    thresholdDays: 21,
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(midnight.getTime() - 1000));
});

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('WebClass assignments on Discord', () => {
  it('posts a silent numbered list only in the newly created channel at JST midnight', async () => {
    const { client, create, todaySend, pastSend } = mockDiscord();
    const job = startDailyScheduler(client);
    try {
      expect(job.nextRun()).toEqual(midnight);
      await vi.advanceTimersByTimeAsync(1000);

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: '使い捨て会話_11月19日' }));
      expect(getUpcomingAssignments).toHaveBeenCalledWith(midnight, true);
      expect(todaySend).toHaveBeenCalledTimes(2);
      expect(todaySend).toHaveBeenNthCalledWith(2, {
        content: expect.stringContaining(`${firstRow}\n${secondRow}`),
        allowedMentions: { parse: [] },
        flags: [MessageFlags.SuppressNotifications],
      });
      expect(pastSend).toHaveBeenCalledOnce();
      expect(pastSend).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('削除確認') }));
      expect(runForumCleanup).toHaveBeenCalledWith(client);
    } finally {
      job.stop();
    }
  });

  it('skips WebClass when today’s channel already existed', async () => {
    const { client, create, todaySend } = mockDiscord(true);
    const job = startDailyScheduler(client);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(create).not.toHaveBeenCalled();
      expect(getUpcomingAssignments).not.toHaveBeenCalled();
      expect(todaySend).not.toHaveBeenCalled();
    } finally {
      job.stop();
    }
  });

  it('still cleans up forum threads when the WebClass session expires', async () => {
    vi.mocked(getUpcomingAssignments).mockRejectedValue(new WebClassError('セッションが期限切れ'));
    const { client, todaySend } = mockDiscord();
    const job = startDailyScheduler(client);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(todaySend).toHaveBeenCalledOnce(); // The welcome message.
      expect(runForumCleanup).toHaveBeenCalledWith(client);
    } finally {
      job.stop();
    }
  });

  it('allows one /kadai request per Discord user every 15 minutes, including concurrent requests', async () => {
    const first = mockInteraction('student-a');
    const duplicate = mockInteraction('student-a');
    const otherUser = mockInteraction('student-b');
    await Promise.all([first.run(), duplicate.run(), otherUser.run()]);

    expect(first.interaction.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(first.interaction.editReply).toHaveBeenCalledWith({
      content: expect.stringContaining(`${firstRow}\n${secondRow}`),
      allowedMentions: { parse: [] },
    });
    expect(duplicate.interaction.reply).toHaveBeenCalledWith({
      content: expect.stringContaining('15分に1回'),
      flags: MessageFlags.Ephemeral,
    });
    expect(otherUser.interaction.editReply).toHaveBeenCalledOnce();
    expect(getUpcomingAssignments).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1);
    await mockInteraction('student-a').run();
    expect(getUpcomingAssignments).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    await mockInteraction('student-a').run();
    expect(getUpcomingAssignments).toHaveBeenCalledTimes(3);
  });

  it('keeps all rows when the list exceeds Discord’s message limit', () => {
    const longList = Array.from({ length: 200 }, () => assignments[0]);
    const message = formatAssignmentMessage(longList);
    expect(message.content).toContain('200件');
    expect(message.files).toEqual([{
      name: 'webclass-kadai.txt',
      attachment: expect.any(Buffer),
    }]);
    const file = message.files?.[0] as { attachment: Buffer };
    expect(file.attachment.toString()).toContain('200. 論理回路Ⅰ ｜ 演習問題 ｜ 2026-11-20 17:45');
  });
});
