import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rename, writeFile } from 'node:fs/promises';
import { chromium, request } from 'playwright';
import { ASSIGNMENT_CACHE_MS, createAssignmentService } from '../src/services/webClass.js';

vi.mock('playwright', () => ({
  chromium: { launchPersistentContext: vi.fn() },
  request: { newContext: vi.fn() },
}));
vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));

const now = new Date('2026-11-19T00:00:00+09:00');
type RequestContext = Awaited<ReturnType<typeof request.newContext>>;
type BrowserContext = Awaited<ReturnType<typeof chromium.launchPersistentContext>>;

function jsonResponse(data: unknown) {
  return {
    ok: () => true,
    status: () => 200,
    headers: () => ({ 'content-type': 'application/json' }),
    json: async () => data,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('WebClass assignments', () => {
  it('loads all courses, keeps submitted and unsubmitted rows, and sorts inclusive seven-day deadlines in JST', async () => {
    const assignment = (title: string, deadline: string | null, hidden = false) => ({
      contents_name: title, end_date: deadline, hidden_content: hidden,
    });
    const get = vi.fn(async (href: string) => {
      const url = new URL(href);
      if (url.pathname.endsWith('/courses')) {
        return jsonResponse([
          { group_id: 'old', group_name: '論理回路', year: 2025 },
          { group_id: 'new', group_name: 'プログラミング', year: 2026 },
        ]);
      }
      if (url.searchParams.get('group_id') === 'old') {
        return jsonResponse([
          { ...assignment('提出済み', '2026-11-26 00:00:00'), answer_datetime: '2026-11-18 09:00:00' },
          assignment('範囲外', '2026-11-26 00:00:01'),
        ]);
      }
      return jsonResponse([
        { ...assignment('未提出', '2026-11-19 00:00:00'), answer_datetime: null },
        assignment('期限切れ', '2026-11-18 23:59:59'),
        assignment('非表示', '2026-11-20 00:00:00', true),
        assignment('締切なし', null),
      ]);
    });
    const dispose = vi.fn();
    vi.mocked(request.newContext).mockResolvedValue({ get, dispose } as unknown as RequestContext);

    await expect(createAssignmentService()(now)).resolves.toEqual([
      { course: 'プログラミング', title: '未提出', deadline: now.getTime() },
      { course: '論理回路', title: '提出済み', deadline: Date.parse('2026-11-26T00:00:00+09:00') },
    ]);
    expect(get).toHaveBeenCalledTimes(3);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('reports login HTML as an expired session when Microsoft requires user action', async () => {
    const get = vi.fn().mockResolvedValue({
      status: () => 200,
      ok: () => true,
      headers: () => ({ 'content-type': 'text/html; charset=UTF-8' }),
    });
    const dispose = vi.fn();
    vi.mocked(request.newContext).mockResolvedValue({ get, dispose } as unknown as RequestContext);
    const close = vi.fn();
    const page = {
      goto: vi.fn(),
      getByRole: () => ({ waitFor: vi.fn().mockRejectedValue(new Error('Microsoft sign-in required')) }),
    };
    vi.mocked(chromium.launchPersistentContext).mockResolvedValue({ pages: () => [page], close } as unknown as BrowserContext);

    await expect(createAssignmentService()(now)).rejects.toThrow(/再ログイン/);
    expect(get).toHaveBeenCalledWith(expect.any(String), { maxRedirects: 0 });
    expect(dispose).toHaveBeenCalledOnce();
    expect(chromium.launchPersistentContext).toHaveBeenCalledWith(
      expect.stringMatching(/chrome$/), expect.objectContaining({ headless: true })
    );
    expect(close).toHaveBeenCalledOnce();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('uses the normal Microsoft SSO flow once and retries with the refreshed WebClass session', async () => {
    const expired = {
      get: vi.fn().mockResolvedValue({ status: () => 302 }),
      dispose: vi.fn(),
    };
    const refreshed = {
      get: vi.fn().mockResolvedValue(jsonResponse([])),
      dispose: vi.fn(),
    };
    vi.mocked(request.newContext)
      .mockResolvedValueOnce(expired as unknown as RequestContext)
      .mockResolvedValueOnce(refreshed as unknown as RequestContext);

    const page = { goto: vi.fn(), getByRole: () => ({ waitFor: vi.fn() }) };
    const context = {
      pages: () => [page],
      request: refreshed,
      close: vi.fn(),
      cookies: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(chromium.launchPersistentContext).mockResolvedValue(context as unknown as BrowserContext);
    vi.mocked(mkdtemp).mockResolvedValue('.webclass/login-test');

    await expect(createAssignmentService()(now)).resolves.toEqual([]);
    expect(expired.dispose).toHaveBeenCalledOnce();
    expect(chromium.launchPersistentContext).toHaveBeenCalledOnce();
    expect(page.goto).toHaveBeenCalledWith(expect.stringContaining('auth_mode=SAML'), expect.any(Object));
    expect(mkdir).toHaveBeenCalledWith('.webclass', { mode: 0o700, recursive: true });
    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('login-test'), '{"cookies":[],"origins":[]}', { mode: 0o600 }
    );
    expect(rename).toHaveBeenCalledWith(expect.stringContaining('login-test'), expect.stringContaining('session.json'));
    expect(context.close).toHaveBeenCalledOnce();
    expect(request.newContext).toHaveBeenCalledTimes(2);
    expect(refreshed.dispose).toHaveBeenCalledOnce();
  });

  it('shares concurrent fetches and reuses results until the cache expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const load = vi.fn().mockResolvedValue([]);
    const upcoming = createAssignmentService(load);

    await Promise.all([upcoming(now), upcoming(now), upcoming(now, true)]);
    await upcoming(now);
    expect(load).toHaveBeenCalledOnce();

    vi.setSystemTime(now.getTime() + ASSIGNMENT_CACHE_MS);
    await upcoming();
    expect(load).toHaveBeenCalledTimes(2);

    await upcoming(now, true);
    expect(load).toHaveBeenCalledTimes(3);
  });
});
