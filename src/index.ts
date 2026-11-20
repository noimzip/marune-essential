import {
  Client,
  Events,
  GatewayIntentBits,
} from 'discord.js';
import { getConfig } from './config.js';
import { startHealthServer } from './server.js';
import { startDailyScheduler, type DailyScheduler } from './scheduler.js';
import { handleInteraction } from './handlers/interactionHandler.js';
import { getGuildCommandDefinitions } from './commands/registry.js';

async function main() {
  console.log('[App] Starting Disposable Channels Discord Bot...');

  const config = getConfig();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
    ],
  });


  let cronJob: DailyScheduler | null = null;

  // 1. Start HTTP health check server immediately for Railway / Render
  const healthServer = await startHealthServer({
    port: config.PORT,
    client,
  });

  // 2. Setup Discord event listeners
  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[App] Logged in as ${readyClient.user.tag}!`);

    // Register slash command for the target guild (immediate availability)
    try {
      const guild = await readyClient.guilds.fetch(config.GUILD_ID);
      if (guild) {
        const commands = getGuildCommandDefinitions(config);
        await guild.commands.set(commands);
        const commandNames = commands.map(({ name }) => `/${name}`).join(', ');
        console.log(
          `[App] Successfully registered guild commands (${commandNames}) in guild '${guild.name}' (${guild.id})`
        );
      } else {
        console.warn(`[App] Guild ${config.GUILD_ID} not found. Skipping slash command registration.`);
      }
    } catch (cmdErr) {
      console.error('[App] Failed to register guild slash commands:', cmdErr);
    }

    // Start 00:00 JST cron job
    cronJob = startDailyScheduler(readyClient);
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    await handleInteraction(interaction);
  });

  client.on(Events.Error, (error) => {
    console.error('[DiscordClient] Client error:', error);
  });

  // 3. Graceful shutdown handler
  let isShuttingDown = false;
  const shutdown = async (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[App] Received ${signal}. Initiating graceful shutdown...`);

    if (cronJob) {
      console.log('[App] Stopping scheduled cron job...');
      cronJob.stop();
    }

    console.log('[App] Closing health check HTTP server...');
    healthServer.close();

    try {
      console.log('[App] Destroying Discord client...');
      await client.destroy();
    } catch (err) {
      console.error('[App] Error during client destruction:', err);
    }

    console.log('[App] Shutdown completed.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[App] Unhandled Rejection at:', promise, 'reason:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('[App] Uncaught Exception:', err);
  });

  // 4. Connect to Discord
  await client.login(config.DISCORD_TOKEN);
}

main().catch((err) => {
  console.error('[App] Fatal startup error:', err);
  process.exit(1);
});
