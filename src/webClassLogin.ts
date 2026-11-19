import { signInToWebClass, WebClassError } from './services/webClass.js';

console.log('開いた Chrome で学校の Microsoft アカウントにサインインしてください。');
signInToWebClass(true)
  .then(() => console.log('WebClass のログインが完了しました。'))
  .catch((error: unknown) => {
    console.error(error instanceof WebClassError
      ? error.message
      : 'WebClass のログインに失敗しました。Google Chrome とブラウザのログイン状態を確認してください。');
    process.exitCode = 1;
  });
