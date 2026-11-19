import http from 'node:http';
import type { Client } from 'discord.js';

export interface HealthServerOptions {
  port: number;
  client?: Client;
}

export async function startHealthServer(options: HealthServerOptions): Promise<http.Server> {
  const { port, client } = options;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/healthz' || url.pathname === '/health') {
      const isBotReady = client ? client.isReady() : true;
      const statusCode = isBotReady ? 200 : 503;

      const responseBody = JSON.stringify({
        status: isBotReady ? 'ok' : 'initializing',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        botStatus: client
          ? {
              ready: client.isReady(),
              tag: client.user?.tag ?? null,
              ping: client.ws?.ping ?? null,
            }
          : undefined,
      });

      res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(responseBody);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  console.log(`[HealthServer] Listening on http://0.0.0.0:${boundPort}/healthz`);
  return server;
}
