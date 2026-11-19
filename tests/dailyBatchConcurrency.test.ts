import { ChannelType, type Client, type Guild } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';
import { configSchema, setConfig } from '../src/config.js';
import { runDailyLifecycle, runLifecycleForGuild } from '../src/services/channelManager.js';
import { BatchAlreadyRunningError } from '../src/utils/batchExecution.js';

const guildId = 'guild';
const categoryId = 'category';
const referenceDate = new Date('2026-02-09T00:00:00+09:00');

function makeFixture() {
  setConfig(configSchema.parse({ DISCORD_TOKEN: 'unused', GUILD_ID: guildId, CATEGORY_ID: categoryId }));
  const channels = {
    fetch: vi.fn().mockResolvedValue(new Map([[categoryId, { type: ChannelType.GuildCategory }]])),
    create: vi.fn().mockResolvedValue({
      name: '使い捨て会話_02月09日',
      send: vi.fn().mockResolvedValue({}),
    }),
  };
  const guild = {
    id: guildId,
    members: { me: { permissions: { has: () => true } } },
    channels,
  } as unknown as Guild;
  const guilds = { fetch: vi.fn().mockResolvedValue(guild) };
  const client = { guilds } as unknown as Client;

  return { guilds, channels, client, guild };
}

describe('daily batch concurrency', () => {
  it('rejects overlapping requests through both entry points before any second channel creation', async () => {
    const { guilds, channels, client, guild } = makeFixture();
    let releaseGuild!: (guild: Guild) => void;
    const firstFetch = new Promise<Guild>((resolve) => { releaseGuild = resolve; });
    guilds.fetch.mockReturnValueOnce(firstFetch);

    const scheduled = runDailyLifecycle(client, referenceDate);
    const manual = runDailyLifecycle(client, referenceDate);
    const direct = runLifecycleForGuild(guild, categoryId, referenceDate);
    releaseGuild(guild);

    await Promise.all([
      expect(scheduled).resolves.toMatchObject({ created: true }),
      expect(manual).rejects.toBeInstanceOf(BatchAlreadyRunningError),
      expect(direct).rejects.toBeInstanceOf(BatchAlreadyRunningError),
    ]);
    expect(guilds.fetch).toHaveBeenCalledOnce();
    expect(channels.fetch).toHaveBeenCalledOnce();
    expect(channels.create).toHaveBeenCalledOnce();
  });

  it('allows the next request when the previous batch fails', async () => {
    const { guilds, channels, client } = makeFixture();
    guilds.fetch.mockRejectedValueOnce(new Error('Discord lookup failed'));

    await expect(runDailyLifecycle(client, referenceDate)).rejects.toThrow('Discord lookup failed');
    await expect(runDailyLifecycle(client, referenceDate)).resolves.toMatchObject({ created: true });
    expect(channels.create).toHaveBeenCalledOnce();
  });
});
