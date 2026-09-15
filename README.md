# 📺 YouTube Trend Radar

Дашборд для отслеживания вирусных YouTube Shorts: ведёте базу каналов по нишам, система сканирует новые видео через RSS (бесплатно), находит «выстрелившие» ролики по коэффициенту аномальности просмотров и раскладывает их по подборкам.

## Возможности

- 🗂 **База каналов по нишам** — каналы группируются по нишам, поиск каналов прямо из интерфейса через YouTube API
- 📡 **RSS-сканирование** — проверка свежих видео всех каналов **без расхода квоты API**
- 🔥 **Поиск вирусных видео** — пакетные запросы статистики (1 ед. квоты на 50 видео), расчёт аномальности относительно средних просмотров канала
- 📊 **Учёт квоты** — счётчик расхода YouTube Data API v3 с автосбросом в 00:00 PT
- ⭐ **Подборки** — ручные коллекции каналов с отдельным сканированием и экспортом результатов
- 🌐 **Веб-дашборд** — единый интерфейс на `localhost:3000`

## Быстрый старт

```bash
# 1. Клонировать и установить зависимости
git clone https://github.com/lexxgreat/trend.git
cd trend
npm install

# 2. Настроить ключ API
cp .env.example .env
# Открой .env и вставь свой ключ YouTube Data API v3

# 3. Запустить дашборд
npm start
# → http://localhost:3000
```

### Получение ключа YouTube API

1. Открой [Google Cloud Console](https://console.cloud.google.com/)
2. Создай проект → включи **YouTube Data API v3**
3. [API-ключи](https://console.cloud.google.com/apis/credentials) → создать ключ
4. Вставь ключ в файл `.env`

> ⚠️ Никогда не публикуй ключ в коде. Файл `.env` добавлен в `.gitignore`.
> Для безопасности ограничь ключ только YouTube Data API v3 в настройках.

## Структура проекта

```
├── server.mjs              # Express-сервер: дашборд + REST API
├── findViralVideos.mjs     # Поиск вирусных видео через API (запускается сервером)
├── scanChannelsRss.mjs     # RSS-сканер каналов (запускается сервером)
├── enrichChannels.mjs      # Обогащение новых каналов метриками
├── index.mjs               # CLI-версия радара (ранний прототип)
├── config.mjs              # Конфиг: чтение YOUTUBE_API_KEY из .env
├── utils/
│   ├── apiBatcher.mjs      # Пакетные запросы к YouTube API (50 видео/запрос)
│   └── trendAnalyzer.mjs   # Анализ аномальности просмотров
├── public/
│   └── index.html          # Веб-дашборд (SPA)
├── channels.json           # База каналов по нишам (данные)
├── niches.json             # Список ниш (данные)
├── collections.json        # Подборки (данные)
├── viral_shorts_results.json  # Результаты сканирований
└── quota.json              # Счётчик квоты API
```

## Утилиты (разовые скрипты)

| Скрипт | Назначение |
|--------|-----------|
| `node migrate.mjs` | Миграция структуры данных |
| `node initChannels.mjs` | Построение channels.json из результатов скана |
| `node dedupe.mjs` | Удаление дубликатов из данных |
| `node fixChannelsAvg.mjs` | Пересчёт средних просмотров каналов |
| `node metrics.mjs` | Сводная статистика по базе |

## Технологии

Node.js 18+ · Express 5 · YouTube Data API v3 · rss-parser · vanilla JS frontend
