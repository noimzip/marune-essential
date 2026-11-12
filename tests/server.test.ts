import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { startHealthServer } from '../src/server.js';

describe('HealthServer (/healthz)', () => {
  let server: http.Server | null = null;

  afterEach(() => {
    if (server) {
      server.close();
      server = null;
    }
  });

  it('should respond 200 OK with json status on /healthz', async () => {
    const mockClient: any = {
      isReady: () => true,
      user: { tag: 'TestBot#1234' },
      ws: { ping: 42 },
    };

    server = startHealthServer({ port: 9876, client: mockClient });

    const response = await fetch('http://127.0.0.1:9876/healthz');
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.status).toBe('ok');
    expect(body.botStatus).toEqual({
      ready: true,
      tag: 'TestBot#1234',
      ping: 42,
    });
    expect(typeof body.uptime).toBe('number');
  });

  it('should respond 503 if client is not ready', async () => {
    const mockClient: any = {
      isReady: () => false,
      user: null,
      ws: { ping: -1 },
    };

    server = startHealthServer({ port: 9877, client: mockClient });

    const response = await fetch('http://127.0.0.1:9877/healthz');
    expect(response.status).toBe(503);

    const body = await response.json();
    expect(body.status).toBe('initializing');
    expect(body.botStatus.ready).toBe(false);
  });

  it('should respond 404 on unknown paths', async () => {
    server = startHealthServer({ port: 9878 });

    const response = await fetch('http://127.0.0.1:9878/unknown-path');
    expect(response.status).toBe(404);

    const body = await response.json();
    expect(body.error).toBe('Not Found');
  });
});
