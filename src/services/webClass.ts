import { request, type APIRequestContext } from 'playwright';
import { z } from 'zod';

const WEBCLASS_ORIGIN = 'https://webclass.kosen-k.go.jp';
const DASHBOARD_API = `${WEBCLASS_ORIGIN}/webclass/ip_mods.php/plugin/score_summary_table`;
export const WEBCLASS_LOGIN_URL = `${WEBCLASS_ORIGIN}/webclass/login.php?auth_mode=SAML`;
export const WEBCLASS_SESSION_FILE = '.webclass/session.json';
export const WEBCLASS_COURSES_URL = `${DASHBOARD_API}/courses`;
export const WEBCLASS_CONTENTS_URL = `${DASHBOARD_API}/contents`;

const DAY_MS = 24 * 60 * 60 * 1000;
export const ASSIGNMENT_CACHE_MS = 15 * 60 * 1000;
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

async function readList<T>(session: APIRequestContext, url: string, schema: z.ZodType<T>): Promise<T> {
  const response = await session.get(url, { maxRedirects: 0 }).catch(() => {
    throw new WebClassError('WebClass への接続に失敗しました。');
  });
  if ([301, 302, 303, 307, 308, 401, 403].includes(response.status())) {
    throw new WebClassError('WebClass のセッションが無効です。運用者が再ログインしてください。');
  }
  if (!response.ok()) {
    throw new WebClassError(`WebClass が HTTP ${response.status()} を返しました。`);
  }
  if (response.headers()['content-type']?.includes('text/html')) {
    // The dashboard returns a login page with HTTP 200 when the session has expired.
    throw new WebClassError('WebClass のセッションが無効です。運用者が再ログインしてください。');
  }
  const result = schema.safeParse(await response.json().catch(() => undefined));
  if (!result.success) {
    throw new WebClassError('WebClass の応答形式が変わったため、課題を読み取れませんでした。');
  }
  return result.data;
}

export function readWebClassCourses(session: APIRequestContext) {
  return readList(session, WEBCLASS_COURSES_URL, coursesSchema);
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

async function loadAssignments(): Promise<Assignment[]> {
  const session = await request.newContext({
    storageState: WEBCLASS_SESSION_FILE,
    timeout: 10_000,
  }).catch(() => {
    throw new WebClassError('WebClass のログイン情報を読み込めません。運用者がログインしてください。');
  });

  try {
    const courses = await readWebClassCourses(session);
    const assignments: Assignment[] = [];
    for (let offset = 0; offset < courses.length; offset += COURSE_CONCURRENCY) {
      const batch = await Promise.all(courses.slice(offset, offset + COURSE_CONCURRENCY).map(async (course) => {
        const url = new URL(WEBCLASS_CONTENTS_URL);
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

export function createAssignmentService(load = loadAssignments) {
  let cache: { assignments: Assignment[]; expiresAt: number } | undefined;
  let loading: Promise<Assignment[]> | undefined;

  return async function getUpcomingAssignments(now = new Date(), refresh = false): Promise<Assignment[]> {
    let assignments: Assignment[];
    if (!loading && !refresh && cache && cache.expiresAt > Date.now()) {
      assignments = cache.assignments;
    } else {
      loading ??= load()
        .then((assignments) => {
          cache = { assignments, expiresAt: Date.now() + ASSIGNMENT_CACHE_MS };
          return assignments;
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
