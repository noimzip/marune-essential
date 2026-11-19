import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, request, type APIRequestContext } from 'playwright';
import { z } from 'zod';

const WEBCLASS_ORIGIN = 'https://webclass.kosen-k.go.jp';
const DASHBOARD_API = `${WEBCLASS_ORIGIN}/webclass/ip_mods.php/plugin/score_summary_table`;
const LOGIN_URL = `${WEBCLASS_ORIGIN}/webclass/login.php?auth_mode=SAML`;
const COURSES_URL = `${DASHBOARD_API}/courses`;
const CONTENTS_URL = `${DASHBOARD_API}/contents`;
const STATE_DIRECTORY = '.webclass';
const SESSION_FILE = join(STATE_DIRECTORY, 'session.json');
const BROWSER_PROFILE = join(STATE_DIRECTORY, 'chrome');

const DAY_MS = 24 * 60 * 60 * 1000;
export const ASSIGNMENT_CACHE_MS = 15 * 60 * 1000;
export const WEBCLASS_RETRY_INTERVAL_MS = 5 * 60 * 1000;
const COURSE_CONCURRENCY = 4;

const coursesSchema = z.array(z.object({
  group_id: z.string().min(1),
  group_name: z.string().trim().min(1),
}));
const contentsSchema = z.array(z.object({
  contents_name: z.string().trim().min(1),
  end_date: z.string().nullable(),
  hidden_content: z.boolean(),
}));

export interface Assignment {
  course: string;
  title: string;
  deadline: number;
}

export class WebClassError extends Error {}

class ExpiredSessionError extends WebClassError {
  constructor() {
    super('WebClass のセッションが無効です。運用者が再ログインしてください。');
  }
}

async function readList<T>(session: APIRequestContext, url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await session.get(url, { maxRedirects: 0 }).catch(() => {
    throw new WebClassError('WebClass への接続に失敗しました。');
  });
  if ([301, 302, 303, 307, 308, 401, 403].includes(response.status())) {
    throw new ExpiredSessionError();
  }
  if (!response.ok()) {
    throw new WebClassError(`WebClass が HTTP ${response.status()} を返しました。`);
  }
  if (response.headers()['content-type']?.includes('text/html')) {
    // The dashboard returns a login page with HTTP 200 when the session has expired.
    throw new ExpiredSessionError();
  }
  const result = schema.safeParse(await response.json().catch(() => undefined));
  if (!result.success) {
    throw new WebClassError('WebClass の応答形式が変わったため、課題を読み取れませんでした。');
  }
  return result.data;
}

export async function signInToWebClass(interactive: boolean): Promise<void> {
  await mkdir(STATE_DIRECTORY, { mode: 0o700, recursive: true });
  const browser = await chromium.launchPersistentContext(BROWSER_PROFILE, {
    channel: 'chrome',
    headless: !interactive,
    locale: 'ja-JP',
    timeout: 15_000,
  });
  try {
    const page = browser.pages()[0] ?? await browser.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.getByRole('link', { name: /ダッシュボード|dashboard/i }).waitFor({
      timeout: interactive ? 300_000 : 15_000,
    });
    await readList(browser.request, COURSES_URL, coursesSchema);

    const cookies = await browser.cookies([COURSES_URL, CONTENTS_URL]);
    const tempDirectory = await mkdtemp(join(STATE_DIRECTORY, 'login-'));
    try {
      const tempFile = join(tempDirectory, 'session.json');
      await writeFile(tempFile, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
      await rename(tempFile, SESSION_FILE);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  } finally {
    await browser.close();
  }
}

function parseDeadline(value: string): number {
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value);
  if (match) {
    const timestamp = Date.parse(`${match[1]}T${match[2]}+09:00`);
    if (Number.isFinite(timestamp)) {
      const jst = new Date(timestamp + 9 * 60 * 60 * 1000).toISOString();
      if (jst.slice(0, 19).replace('T', ' ') === value) return timestamp;
    }
  }
  throw new WebClassError('WebClass の締切日時を読み取れませんでした。');
}

async function loadWithSavedSession(): Promise<Assignment[]> {
  const session = await request.newContext({
    storageState: SESSION_FILE,
    timeout: 10_000,
  }).catch(() => {
    throw new WebClassError('WebClass のログイン情報を読み込めません。運用者がログインしてください。');
  });

  try {
    const courses = await readList(session, COURSES_URL, coursesSchema);
    const assignments: Assignment[] = [];
    for (let offset = 0; offset < courses.length; offset += COURSE_CONCURRENCY) {
      const batch = await Promise.all(courses.slice(offset, offset + COURSE_CONCURRENCY).map(async (course) => {
        const url = new URL(CONTENTS_URL);
        url.searchParams.set('group_id', course.group_id);
        const items = await readList(session, url.href, contentsSchema);
        return items.flatMap((item) => item.hidden_content || !item.end_date ? [] : [{
            course: course.group_name,
            title: item.contents_name,
            deadline: parseDeadline(item.end_date),
        }]);
      }));
      assignments.push(...batch.flat());
    }
    return assignments;
  } finally {
    await session.dispose();
  }
}

async function loadAssignments(): Promise<Assignment[]> {
  try {
    return await loadWithSavedSession();
  } catch (error) {
    if (!(error instanceof ExpiredSessionError)) throw error;

    // Use the normal SSO flow in the dedicated browser if Microsoft still has a valid sign-in.
    await signInToWebClass(false).catch(() => { throw error; });
    return loadWithSavedSession();
  }
}

export function createAssignmentService(load = loadAssignments) {
  let cache: { assignments: Assignment[]; expiresAt: number } | undefined;
  let loading: Promise<Assignment[]> | undefined;
  let failure: { error: unknown; retryAt: number } | undefined;

  return async function getUpcomingAssignments(now = new Date(), refresh = false): Promise<Assignment[]> {
    let assignments: Assignment[];
    if (!loading && !refresh && cache && cache.expiresAt > Date.now()) {
      assignments = cache.assignments;
    } else {
      if (failure && failure.retryAt > Date.now()) {
        throw failure.error;
      }
      loading ??= Promise.resolve()
        .then(load)
        .then((assignments) => {
          cache = { assignments, expiresAt: Date.now() + ASSIGNMENT_CACHE_MS };
          failure = undefined;
          return assignments;
        })
        .catch((error: unknown) => {
          failure = { error, retryAt: Date.now() + WEBCLASS_RETRY_INTERVAL_MS };
          throw error;
        })
        .finally(() => { loading = undefined; });
      assignments = await loading;
    }

    const from = now.getTime();
    return assignments
      .filter(({ deadline }) => deadline >= from && deadline <= from + 7 * DAY_MS)
      .sort((a, b) => a.deadline - b.deadline);
  };
}

export const getUpcomingAssignments = createAssignmentService();
