import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from 'playwright';
import { ASSIGNMENT_CACHE_MS, createAssignmentService } from '../src/services/webClass.js';

vi.mock('playwright', () => ({
  request: { newContext: vi.fn() },
}));

const now = new Date('2026-11-19T00:00:00+09:00');

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe('WebClass assignments', () => {
  it('loads all courses, keeps submitted and unsubmitted rows, and sorts inclusive seven-day deadlines in JST', async () => {
    const response = (data: unknown) => ({
      ok: () => true,
      status: () => 200,
      headers: () => ({ 'content-type': 'application/json' }),
      json: async () => data,
    });
    const assignment = (title: string, deadline: string | null, hidden = false) => ({
      contents_name: title, end_date: deadline, hidden_content: hidden,
    });
    const get = vi.fn(async (href: string) => {
      const url = new URL(href);
      if (url.pathname.endsWith('/courses')) {
        return response([
          { group_id: 'old', group_name: '論理回路', year: 2025 },
          { group_id: 'new', group_name: 'プログラミング', year: 2026 },
        ]);
      }
      if (url.searchParams.get('group_id') === 'old') {
        return response([
          { ...assignment('提出済み', '2026-11-26 00:00:00'), answer_datetime: '2026-11-18 09:00:00' },
          assignment('範囲外', '2026-11-26 00:00:01'),
        ]);
      }
      return response([
        { ...assignment('未提出', '2026-11-19 00:00:00'), answer_datetime: null },
        assignment('期限切れ', '2026-11-18 23:59:59'),
        assignment('非表示', '2026-11-20 00:00:00', true),
        assignment('締切なし', null),
      ]);
    });
    const dispose = vi.fn();
    vi.mocked(request.newContext).mockResolvedValue({ get, dispose } as unknown as Awaited<ReturnType<typeof request.newContext>>);

    await expect(createAssignmentService()(now)).resolves.toEqual([
      { course: 'プログラミング', title: '未提出', deadline: now.getTime() },
      { course: '論理回路', title: '提出済み', deadline: Date.parse('2026-11-26T00:00:00+09:00') },
    ]);
    expect(get).toHaveBeenCalledTimes(3);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('reports login HTML as an expired session even when the HTTP status is 200', async () => {
    const get = vi.fn().mockResolvedValue({
      status: () => 200,
      ok: () => true,
      headers: () => ({ 'content-type': 'text/html; charset=UTF-8' }),
    });
    const dispose = vi.fn();
    vi.mocked(request.newContext).mockResolvedValue({ get, dispose } as unknown as Awaited<ReturnType<typeof request.newContext>>);

    await expect(createAssignmentService()(now)).rejects.toThrow(/再ログイン/);
    expect(get).toHaveBeenCalledWith(expect.any(String), { maxRedirects: 0 });
    expect(dispose).toHaveBeenCalledOnce();
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
