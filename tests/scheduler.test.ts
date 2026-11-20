import {
  ChannelType,
  Collection,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type MessageCreateOptions,
} from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDailyBatchRun } from '../src/commands/dailyBatchRun.js';
import { configSchema, setConfig } from '../src/config.js';
import { handleInteraction } from '../src/handlers/interactionHandler.js';
import { startDailyScheduler, type DailyScheduler } from '../src/scheduler.js';
import { BUTTON_IDS } from '../src/services/channelManager.js';
import { runForumCleanup } from '../src/services/forumManager.js';
import { formatChannelName } from '../src/utils/dateUtils.js';

vi.mock('../src/services/forumManager.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/forumManager.js')>(),
  runForumCleanup: vi.fn(),
}));

const guildId = 'daily-scheduler-test';
const categoryId = 'category';
const midnight = new Date('2026-11-20T00:00:00+09:00');
const yesterday = new Date('2026-11-19T00:00:00+09:00');
const retryInterval = 5 * 60 * 1000;

function makeChannel(name: string, createdAt: Date) {
  const history = new Collection<string, {
    id: string;
    author: { id: string };
    createdTimestamp: number;
    content: string;
  }>();
  const messages = { fetch: vi.fn(async () => history) };
  return {
    name,
    createdAt,
    type: ChannelType.GuildText,
    parentId: categoryId,
    permissionsFor: () => ({ has: () => true }),
    messages,
    history,
    send: vi.fn(async ({ content }: MessageCreateOptions) => {
      const id = String(history.size + 1);
      history.set(id, { id, content: content ?? '', createdTimestamp: Date.now(), author: { id: 'bot' } });
    }),
    delete: vi.fn(),
  };
}

function mockDiscord(...existingChannels: ReturnType<typeof makeChannel>[]) {
  const channels = new Map<string, object>([[categoryId, { type: ChannelType.GuildCategory }]]);
  for (const channel of existingChannels) channels.set(channel.name, channel);
  const create = vi.fn(async ({ name }: { name: string; topic?: string }) => {
    const channel = makeChannel(name, new Date());
    channels.set(name, channel);
    return channel;
  });
  const fetch = vi.fn(async () => new Map(channels));
  const client = {
    guilds: {
      fetch: async () => ({
        id: guildId,
        members: { me: { id: 'bot', permissions: { has: () => true } } },
        channels: { fetch, create },
      }),
    },
  } as unknown as Client;
  return { client, fetch, create, channels };
}

let scheduler: DailyScheduler | undefined;

beforeEach(() => {
  setConfig(configSchema.parse({ DISCORD_TOKEN: 'test', GUILD_ID: guildId, CATEGORY_ID: categoryId }));
  vi.mocked(runForumCleanup).mockResolvedValue({
    inspectedForumCount: 0, inspectedThreadCount: 0, skippedPinnedCount: 0, skippedAlreadyConfirmedCount: 0,
    targets: [], confirmSentThreads: [], errors: [], dryRun: false, thresholdDays: 21,
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(midnight.getTime() - 1000));
});

afterEach(() => {
  scheduler?.stop();
  scheduler = undefined;
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('today’s disposable channel recovery', () => {
  it('creates only the current channel on a restart after the midnight run was missed', async () => {
    vi.setSystemTime(new Date('2026-11-20T12:00:00+09:00'));
    const past = makeChannel(formatChannelName(yesterday), yesterday);
    const { client, create } = mockDiscord(past);
    scheduler = startDailyScheduler(client);

    await vi.advanceTimersByTimeAsync(0);

    expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: formatChannelName(midnight) }));
    expect(past.send).not.toHaveBeenCalled();
    expect(runForumCleanup).not.toHaveBeenCalled();
  });

  it('retries after a creation failure at midnight without repeating the past-channel and forum work', async () => {
    const past = makeChannel(formatChannelName(yesterday), yesterday);
    const { client, create, channels } = mockDiscord(past);
    create.mockRejectedValueOnce(new Error('temporary Discord failure'));
    scheduler = startDailyScheduler(client);

    await vi.advanceTimersByTimeAsync(1000);
    expect(create).toHaveBeenCalledOnce();
    expect(past.send).toHaveBeenCalledOnce();
    expect(runForumCleanup).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(retryInterval - 1);
    expect(create).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(channels.has(formatChannelName(midnight))).toBe(true);
    expect(past.send).toHaveBeenCalledOnce();
    expect(runForumCleanup).toHaveBeenCalledOnce();
  });

  it('keeps a single creation when startup recovery overlaps the midnight batch', async () => {
    const { client, fetch, create, channels } = mockDiscord();
    let release!: (snapshot: Map<string, object>) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    scheduler = startDailyScheduler(client);

    await vi.advanceTimersByTimeAsync(1000);
    expect(create).not.toHaveBeenCalled();

    release(new Map(channels));
    await vi.advanceTimersByTimeAsync(0);
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: formatChannelName(midnight) }));
    expect(runForumCleanup).toHaveBeenCalledOnce();
  });

  it('leaves an existing channel alone after restarting during the day', async () => {
    vi.setSystemTime(new Date('2026-11-20T12:00:00+09:00'));
    const today = makeChannel('使い捨て会話-11月20日', midnight);
    const { client, create, fetch } = mockDiscord(today);
    scheduler = startDailyScheduler(client);

    await vi.advanceTimersByTimeAsync(retryInterval);

    expect(fetch).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(today.send).not.toHaveBeenCalled();
    expect(runForumCleanup).not.toHaveBeenCalled();
  });
});

describe('same-day daily deletion prompts', () => {
  it.each([false, true])('does not repeat a scheduled confirmation on manual execution (postponed %s)', async (postponed) => {
    const past = makeChannel(formatChannelName(yesterday), yesterday);
    const { client } = mockDiscord(past);
    scheduler = startDailyScheduler(client);
    await vi.advanceTimersByTimeAsync(1000);
    expect(past.send).toHaveBeenCalledOnce();

    if (postponed) {
      const confirmation = past.history.first()!;
      const update = vi.fn(async ({ content }: { content: string }) => { confirmation.content = content; });
      await handleInteraction({
        isChatInputCommand: () => false,
        isButton: () => true,
        customId: BUTTON_IDS.CANCEL_DELETE,
        memberPermissions: { has: () => true },
        user: { id: 'moderator' },
        update,
      } as unknown as Interaction);
      expect(update).toHaveBeenCalledOnce();
      expect(confirmation.content).toContain('削除は保留されました');
    }

    scheduler.stop();
    scheduler = startDailyScheduler(client);
    await vi.advanceTimersByTimeAsync(0);
    const editReply = vi.fn();
    await handleDailyBatchRun({
      client,
      memberPermissions: { has: () => true },
      deferReply: vi.fn(),
      editReply,
    } as unknown as ChatInputCommandInteraction);

    expect(past.send).toHaveBeenCalledOnce();
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('削除確認送信**: 0 件'),
    }));
  });
});
