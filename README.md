# Планировщик городского досуга для MAX

Воспроизводимый стартовый контур mini-app: React-клиент на официальном MAX UI, MAX Bridge, Fastify API и серверная проверка подписи `initData`. Сам планировщик пока намеренно не реализован: его механизмы сначала доводятся до согласованной спецификации M2.

## Что уже работает

- адаптивная светлая/тёмная оболочка mini-app;
- запуск в обычном браузере как безопасный preview без пользовательских данных;
- получение `window.WebApp.initData` при запуске из MAX;
- серверная HMAC-SHA256 проверка подписи и срока жизни `initData`;
- healthcheck и единый production-контейнер для frontend и backend;
- unit-тесты валидной, изменённой, дублированной, просроченной и будущей подписи.

## Требования

- Node.js `24.15.0` (закреплён в `.nvmrc`; минимально `22.15.0`);
- npm из поставки Node.js;
- Docker с Compose — для контейнерного запуска.

## Первый локальный запуск

```shell
npm ci
npm run env:init
npm run dev
```

После `npm run env:init` заполните `MAX_BOT_TOKEN` в `.env.local`. Откройте клиент на `http://127.0.0.1:5173`; API работает на `http://127.0.0.1:3000` и проксируется Vite.

`.env.local` игнорируется Git. В репозитории хранится только `.env.example`; реальные секреты передаются команде через защищённый канал и задаются в secret store хостинга/CI. Никогда не добавляйте серверный токен в переменные с префиксом `VITE_`.

## Команды

| Команда | Назначение |
|---|---|
| `npm run dev` | клиент и API с hot reload |
| `npm run check` | typecheck, тесты и чистая production-сборка |
| `npm run build` | сборка в `dist/client` и `dist/server` |
| `npm start` | запуск предварительно собранного production-сервера |
| `npm run smoke:max` | безопасная проверка токена через `GET /me` |
| `npm run env:init` | создание локального `.env.local` из схемы |

## Запуск в Docker

Сначала один раз создайте `.env.local`, затем:

```shell
npm run env:init
docker compose up --build
```

Приложение откроется на `http://127.0.0.1:3000`: Compose публикует внутренний порт контейнера `8080` на локальном порту `3000`. Compose запускает контейнер с read-only filesystem, непривилегированным пользователем и healthcheck. Остановка:

```shell
docker compose down
```

## Переменные окружения

| Переменная | Обязательность | Назначение |
|---|---|---|
| `MAX_BOT_TOKEN` | для запуска из MAX | серверный секрет проверки `initData` |
| `MAX_INIT_DATA_TTL_SECONDS` | нет, default `3600` | максимальный возраст данных запуска |
| `HOST` | нет, default `0.0.0.0` | адрес прослушивания |
| `PORT` | нет, default `3000`; Docker image `8080` | порт HTTP-сервера |
| `PUBLIC_BASE_URL` | для production | постоянный публичный HTTPS URL mini-app |

## API и граница доверия

- `GET /api/health` — readiness/health endpoint;
- `POST /api/auth/max` — принимает только `{ "initData": "..." }`, проверяет подпись, `auth_date` и пользователя;
- остальные GET-запросы с `Accept: text/html` возвращают SPA.

Frontend не доверяет `initDataUnsafe` и не получает `MAX_BOT_TOKEN`. В обычном браузере он показывает preview; пользователь считается подтверждённым только после успешного ответа `/api/auth/max`. Логи редактируют `Authorization` и `initData`.

## Production и привязка к MAX

1. Разверните этот контейнер на постоянном HTTPS-домене.
2. Передайте хостингу переменные из `.env.example` через его secret store.
3. Проверьте `GET https://<домен>/api/health` и мобильный экран.
4. В настройках выданного бота MAX укажите этот HTTPS URL как ссылку mini-app.
5. Откройте mini-app из чата и убедитесь, что экран показывает подтверждённый контекст MAX.
6. Только после этого отправляйте ссылку в форму организаторов.

В форму нужна ссылка на приложение, а не токен, URL репозитория, localhost или временный tunnel.

## Структура

```text
src/client/  React/MAX UI и MAX Bridge
src/server/  Fastify API, разбор окружения, проверка initData
src/shared/  общие типизированные контракты
scripts/     воспроизводимые локальные команды
```

## Официальные источники интеграции

- [Создание mini-app](https://dev.max.ru/help/miniapps)
- [MAX Bridge](https://dev.max.ru/docs/webapps/bridge)
- [Проверка данных запуска](https://dev.max.ru/docs/webapps/validation)
- [MAX UI](https://dev.max.ru/ui)

Архитектурные решения, требования организаторов и спецификации механизмов ведутся отдельно в служебном репозитории. Перед изменением основного сценария сверяйте оба контура.
