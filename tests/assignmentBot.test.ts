import { ChannelType, Collection, MessageFlags, type Client, type Interaction, type MessageCreateOptions } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setConfig, configSchema } from '../src/config.js';
import { handleInteraction } from '../src/handlers/interactionHandler.js';
import { startDailyScheduler } from '../src/scheduler.js';
import { formatAssignmentMessage } from '../src/services/assignmentMessages.js';
import { runForumCleanup } from '../src/services/forumManager.js';
import { getUpcomingAssignments, WebClassError, WEBCLASS_RETRY_INTERVAL_MS } from '../src/services/webClass.js';

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
const pendingTopic = 'WebClass 課題一覧（2026/11/19・投稿待ち）';
const publishedTopic = 'WebClass 課題一覧（2026/11/19・投稿済み）';
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

function mockDiscord(existingToday = false, existingTopic: string | null = null, pastPending = false) {
  const posted = new Collection<string, { author: { id: string }; content: string }>();
  const todaySend = vi.fn<(message: MessageCreateOptions) => Promise<void>>(async (message) => {
    posted.set(String(posted.size + 1), { author: { id: 'bot' }, content: message.content ?? '' });
  });
  const pastSend = vi.fn();
  const readHistory = vi.fn(async (_options: { before?: string }) => posted);
  const canReadHistory = vi.fn(() => true);
  const today = {
    id: 'today',
    type: ChannelType.GuildText,
    parentId: 'category',
    name: '使い捨て会話_11月19日',
    createdAt: midnight,
    topic: existingTopic,
    send: todaySend,
    fetch: vi.fn(),
    setTopic: vi.fn(async (topic: string) => { today.topic = topic; }),
    messages: { fetch: readHistory },
    permissionsFor: () => ({ has: canReadHistory }),
  };
  today.fetch.mockResolvedValue(today);
  const channels = new Map<string, object>([
    ['category', { type: ChannelType.GuildCategory }],
    ['past', {
      type: ChannelType.GuildText, parentId: 'category', name: '使い捨て会話_11月18日', send: pastSend,
      topic: pastPending ? 'WebClass 課題一覧（2026/11/18・投稿待ち）' : null,
      createdAt: new Date('2026-11-17T15:00:00.000Z'),
      permissionsFor: () => ({ has: () => true }),
      messages: { fetch: vi.fn().mockResolvedValue(new Collection()) },
    }],
  ]);
  if (existingToday) channels.set(today.id, today);
  const create = vi.fn(async ({ topic }: { topic?: string }) => {
    today.topic = topic ?? null;
    channels.set(today.id, today);
    return today;
  });
  const client = {
    user: { id: 'bot' },
    guilds: {
      fetch: async () => ({
        id: 'guild',
        members: { me: { id: 'bot', permissions: { has: () => true } } },
        channels: { fetch: async () => channels, create },
      }),
    },
  } as unknown as Client;
  return { client, create, today, todaySend, pastSend, posted, readHistory, canReadHistory };
}

beforeEach(() => {
  setConfig(configSchema.parse({
    DISCORD_TOKEN: 'test', GUILD_ID: 'guild', CATEGORY_ID: 'category', WEBCLASS_ENABLED: 'true',
  }));
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
  it('skips assignment posting for both newly created channels and pending channels when WebClass is disabled', async () => {
    setConfig(configSchema.parse({ DISCORD_TOKEN: 'test', GUILD_ID: 'guild', CATEGORY_ID: 'category' }));
    const { client, create, today, todaySend, readHistory } = mockDiscord();
    const job = startDailyScheduler(client);
    try {
      await vi.advanceTimersByTimeAsync(WEBCLASS_RETRY_INTERVAL_MS);
      expect(create).toHaveBeenCalledOnce();
      expect(today.topic).toBeNull();
      expect(todaySend).toHaveBeenCalledOnce();
      expect(getUpcomingAssignments).not.toHaveBeenCalled();
    } finally {
      job.stop();
    }

    today.topic = pendingTopic;
    const restartedJob = startDailyScheduler(client);
    try {
      await vi.advanceTimersByTimeAsync(WEBCLASS_RETRY_INTERVAL_MS);
      expect(readHistory).not.toHaveBeenCalled();
      expect(getUpcomingAssignments).not.toHaveBeenCalled();
      expect(todaySend).toHaveBeenCalledOnce();
      expect(today.topic).toBe(pendingTopic);
    } finally {
      restartedJob.stop();
    }
  });

  it('posts a silent numbered list only in the newly created channel at JST midnight', async () => {
    const { client, create, today, todaySend, pastSend } = mockDiscord();
    const job = startDailyScheduler(client);
    try {
      expect(job.nextRun()).toEqual(midnight);
      await vi.advanceTimersByTimeAsync(1000);

      expect(create).toHaveBeenCalledWith(expect.objectContaining({
        name: '使い捨て会話_11月19日',
        topic: pendingTopic,
      }));
      expect(getUpcomingAssignments).toHaveBeenCalledWith(midnight, true);
      expect(todaySend).toHaveBeenCalledTimes(2);
      expect(todaySend).toHaveBeenNthCalledWith(2, {
        content: expect.stringContaining(`${firstRow}\n${secondRow}`),
        allowedMentions: { parse: [] },
        flags: [MessageFlags.SuppressNotifications],
        nonce: 'hw:today',
        enforceNonce: true,
      });
      expect(today.topic).toBe(publishedTopic);
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

  it('retries only the WebClass post after a temporary fetch failure', async () => {
    vi.mocked(getUpcomingAssignments).mockRejectedValueOnce(new WebClassError('セッションが期限切れ'));
    const { client, create, today, todaySend, pastSend } = mockDiscord();
    const job = startDailyScheduler(client);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(todaySend).toHaveBeenCalledOnce(); // The welcome message.
      expect(today.topic).toBe(pendingTopic);
      expect(runForumCleanup).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(WEBCLASS_RETRY_INTERVAL_MS);
      expect(todaySend).toHaveBeenCalledTimes(2);
      expect(today.topic).toBe(publishedTopic);
      expect(create).toHaveBeenCalledOnce();
      expect(pastSend).toHaveBeenCalledOnce();
      expect(runForumCleanup).toHaveBeenCalledOnce();
    } finally {
      job.stop();
    }
  });

  it('retries an unacknowledged send when its message was never created', async () => {
    const { client, today, todaySend, readHistory } = mockDiscord();
    todaySend.mockImplementationOnce(async () => {}).mockRejectedValueOnce(new Error('Discord unavailable'));
    const job = startDailyScheduler(client);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(today.topic).toBe(pendingTopic);
      expect(todaySend).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(WEBCLASS_RETRY_INTERVAL_MS);
      expect(readHistory).toHaveBeenCalledOnce();
      expect(todaySend).toHaveBeenCalledTimes(3);
      expect(today.topic).toBe(publishedTopic);
    } finally {
      job.stop();
    }
  });

  it('recovers a delivered message after a send timeout and bot restart without posting twice', async () => {
    const { client, create, today, todaySend, posted, pastSend, readHistory } = mockDiscord();
    todaySend.mockImplementationOnce(async () => {}).mockImplementationOnce(async (message) => {
      posted.set('1', { author: { id: 'bot' }, content: message.content ?? '' });
      throw new Error('Discord response was lost');
    });
    const firstJob = startDailyScheduler(client);
    try {
      await vi.advanceTimersByTimeAsync(1000);
      expect(today.topic).toBe(pendingTopic);
    } finally {
      firstJob.stop();
    }

    readHistory.mockResolvedValueOnce(new Collection(Array.from({ length: 100 }, (_, i) =>
      [String(101 - i), { author: { id: 'student' }, content: '投稿後の会話' }]
    )));
    const restartedJob = startDailyScheduler(client);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(today.topic).toBe(publishedTopic);
      expect(readHistory).toHaveBeenNthCalledWith(2, { before: '2', limit: 100, cache: false });
      expect(todaySend).toHaveBeenCalledTimes(2);
      expect(getUpcomingAssignments).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledOnce();
      expect(pastSend).toHaveBeenCalledOnce();
      expect(runForumCleanup).toHaveBeenCalledOnce();
    } finally {
      restartedJob.stop();
    }
  });

  it('posts a pending channel on startup even when an unrelated user posted the same heading', async () => {
    vi.setSystemTime(new Date(midnight.getTime() + 1));
    const { client, create, today, todaySend, posted, pastSend } = mockDiscord(true, pendingTopic);
    posted.set('1', { author: { id: 'student' }, content: formatAssignmentMessage(assignments).content ?? '' });
    const job = startDailyScheduler(client);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(today.topic).toBe(publishedTopic);
      expect(todaySend).toHaveBeenCalledOnce();
      expect(create).not.toHaveBeenCalled();
      expect(pastSend).not.toHaveBeenCalled();
      expect(runForumCleanup).not.toHaveBeenCalled();
    } finally {
      job.stop();
    }
  });

  it('ignores pending channels from yesterday and never posts where history cannot be checked', async () => {
    vi.setSystemTime(new Date(midnight.getTime() + 1));
    const { client, today, todaySend, readHistory, canReadHistory, pastSend } = mockDiscord(true, pendingTopic, true);
    canReadHistory.mockReturnValue(false);
    const job = startDailyScheduler(client);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(today.topic).toBe(pendingTopic);
      expect(todaySend).not.toHaveBeenCalled();
      expect(readHistory).not.toHaveBeenCalled();
      expect(pastSend).not.toHaveBeenCalled();
      expect(runForumCleanup).not.toHaveBeenCalled();
    } finally {
      job.stop();
    }
  });

  it('does not post when an in-flight recovery finishes after JST midnight', async () => {
    const nextMidnight = new Date('2026-11-20T00:00:00+09:00');
    vi.setSystemTime(new Date(nextMidnight.getTime() - 1000));
    const { client, todaySend } = mockDiscord(true, pendingTopic);
    let finishLoad!: (result: typeof assignments) => void;
    vi.mocked(getUpcomingAssignments).mockImplementationOnce(() => new Promise((resolve) => {
      finishLoad = resolve;
    }));

    const job = startDailyScheduler(client);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(getUpcomingAssignments).toHaveBeenCalledOnce();
      vi.setSystemTime(nextMidnight);
      finishLoad(assignments);
      await vi.advanceTimersByTimeAsync(0);
      expect(todaySend).not.toHaveBeenCalled();
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
