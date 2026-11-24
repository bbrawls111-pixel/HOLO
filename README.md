# Holo — Private Game Development Workspace

Закрытое рабочее пространство для двух разработчиков: общение, общее хранилище ресурсов,
история версий и ИИ-сессии в одном Electron-приложении.

```
Holo/
├── server/   Vercel Functions: REST + WebSocket, Neon Postgres, Vercel Blob
└── client/   Electron + React + TypeScript + CSS Modules (Vite)
```

## Что уже работает (ядро, этап 1)

- **Вход** — два заранее созданных аккаунта, регистрация закрыта.
- **Ник и аватар** — выбираются при первом входе, меняются в «Настройках».
- **Онлайн-статус** — при входе клиент шлёт `POST /api/presence/online`, сервер показывает «онлайн».
  Клиент повторяет запрос раз в 5 минут, и каждый такой запрос проверяет остальных: кто не отметился
  за 5 минут (+1 минута запаса), переводится в офлайн. При закрытии приложения статус снимается сразу.
- **Синхронизация** — действие = один HTTP-запрос → событие в журнале → `pg_notify` →
  все экземпляры функции → WebSocket клиентов. После обрыва клиент догружает пропущенное.
- **Ресурсы** — drag & drop файлов и папок, превью, версии, комментарии. Файлы лежат в приватном
  Vercel Blob; клиент заливает их напрямую по одноразовому токену (лимит функции 4,5 МБ не мешает).
- **Чат**, **ИИ-сессии**, **счётчик операций** за месяц (лимит 500 000).

## Архитектура на Vercel

| Задача | Решение |
|---|---|
| REST API и WebSocket | Один Node-сервер `server/src/index.js` → Vercel Function (`maxDuration` 300 с) |
| База данных | Neon Postgres (`DATABASE_URL`, `DATABASE_URL_UNPOOLED`) |
| Файлы | Vercel Blob, приватный (`BLOB_READ_WRITE_TOKEN`) |
| События между экземплярами | Postgres `LISTEN/NOTIFY` |
| Проверка онлайна | на каждом 5-минутном запросе присутствия, без фоновых задач |

WebSocket на Vercel живёт до `maxDuration`, затем клиент переподключается и догоняет события.

## Настройка Vercel

1. Project → Settings → Root Directory: `server`.
2. Storage → подключить **Neon** (Postgres) и **Blob** (private) к проекту.
3. Deployment Protection: отключить Vercel Authentication для Production — у API своя авторизация.
4. Создать аккаунты (с переменными Neon из `vercel env pull`):

```powershell
cd server
npm install
$env:DATABASE_URL = "<из Vercel → Storage → Neon>"
npm run create-user -- <логин1> <пароль1>
npm run create-user -- <логин2> <пароль2>
```

## Локальный запуск

Без `DATABASE_URL` и `BLOB_READ_WRITE_TOKEN` сервер использует встроенный PGlite и локальную папку.

```powershell
cd server; npm install; npm run create-user -- alice password1; npm start
```

```powershell
cd client; npm install; npm run dev
```

При входе укажите адрес сервера: `https://holo-phi-pied.vercel.app` или `http://localhost:4000`.
