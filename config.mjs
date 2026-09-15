import 'dotenv/config';

// Ключ берётся из файла .env (никогда не коммитится в git!)
// См. .env.example
export const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

if (!YOUTUBE_API_KEY) {
  console.warn(
    '⚠️  YOUTUBE_API_KEY не задан!\n' +
    '   Создай файл .env в корне проекта (скопируй .env.example)\n' +
    '   и вставь туда свой ключ YouTube Data API v3.'
  );
}
