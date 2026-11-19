import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { startHealthServer } from '../src/server.js';
import { configSchema } from '../src/config.js';

describe('HealthServer (/healthz)', () => {
  let server: http.Server | null = null;

  afterEach(async () => {
    const listeningServer = server;
    if (listeningServer) {
      await new Promise<void>((resolve) => listeningServer.close(() => resolve()));
      server = null;
    }
  });

  it('should respond 200 OK with json status on /healthz', async () => {
    const mockClient: any = {
      isReady: () => true,
      user: { tag: 'TestBot#1234' },
      ws: { ping: 42 },
    };

    server = await startHealthServer({ port: 9876, client: mockClient });

    const response = await fetch('http://127.0.0.1:9876/healthz');
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({
      status: 'ok',
      botStatus: { ready: true, tag: 'TestBot#1234', ping: 42 },
      uptime: expect.any(Number),
    });
  });

  it('should respond 503 if client is not ready', async () => {
    const mockClient: any = {
      isReady: () => false,
      user: null,
      ws: { ping: -1 },
    };

    server = await startHealthServer({ port: 9877, client: mockClient });

    const response = await fetch('http://127.0.0.1:9877/healthz');
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body).toMatchObject({ status: 'initializing', botStatus: { ready: false } });
  });

  it('should respond 404 on unknown paths', async () => {
    server = await startHealthServer({ port: 9878 });

    const response = await fetch('http://127.0.0.1:9878/unknown-path');
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body).toEqual({ error: 'Not Found' });
  });

  it('rejects startup when another server is already listening', async () => {
    server = await startHealthServer({ port: 0 });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');

    await expect(startHealthServer({ port: address.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('PORT configuration', () => {
  const environment = { DISCORD_TOKEN: 'test', GUILD_ID: 'guild', CATEGORY_ID: 'category' };

  it('defaults to 8080 when omitted and accepts the maximum TCP port', () => {
    expect(configSchema.parse(environment).PORT).toBe(8080);
    expect(configSchema.parse({ ...environment, PORT: '65535' }).PORT).toBe(65535);
  });

  it.each(['', ' ', '0', '-1', '8080.5', '65536'])('rejects invalid port %j', (PORT) => {
    expect(configSchema.safeParse({ ...environment, PORT }).success).toBe(false);
  });
});
