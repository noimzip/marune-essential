import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import {
  readWebClassCourses,
  WEBCLASS_CONTENTS_URL,
  WEBCLASS_COURSES_URL,
  WEBCLASS_LOGIN_URL,
  WEBCLASS_SESSION_FILE,
  WebClassError,
} from './services/webClass.js';

async function main(): Promise<void> {
  const browser = await chromium.launch({ channel: 'chrome', headless: false });
  try {
    const context = await browser.newContext({ locale: 'ja-JP' });
    const page = await context.newPage();
    console.log('開いた Chrome で学校の Microsoft アカウントにサインインしてください。');
    await page.goto(WEBCLASS_LOGIN_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: /ダッシュボード|dashboard/i }).waitFor({ timeout: 300_000 });
    await readWebClassCourses(context.request);

    const cookies = await context.cookies([WEBCLASS_COURSES_URL, WEBCLASS_CONTENTS_URL]);
    const directory = dirname(WEBCLASS_SESSION_FILE);
    await mkdir(directory, { mode: 0o700, recursive: true });
    const tempDirectory = await mkdtemp(join(directory, 'login-'));
    try {
      const tempFile = join(tempDirectory, 'session.json');
      await writeFile(tempFile, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
      await rename(tempFile, WEBCLASS_SESSION_FILE);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
    console.log('WebClass のログインが完了しました。');
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof WebClassError
    ? error.message
    : 'WebClass のログインに失敗しました。Google Chrome とブラウザのログイン状態を確認してください。');
  process.exitCode = 1;
});
