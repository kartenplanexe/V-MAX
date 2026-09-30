# Разработка

Эти шаги не нужны для [Docker-запуска](../README.md#установка-и-запуск). Все команды выполняются из корня проекта.

## Подготовка

Установите Node.js 24.15.0 и uv 0.11.14. Команда uv ниже установит Python 3.12.13, если его нет:

```sh
npm ci
uv sync --project planner --frozen --python 3.12.13
```

## Пример без ключей

После подготовки выполните:

```sh
npm run planner:form:demo
```

Откройте `http://127.0.0.1:4174/planner-form`. Пример использует вымышленные места и время дороги, но настоящий Python-планировщик. Он не читает `.env.local`, не требует MAX и не вызывает внешние API. Измените условия, получите план, проверьте ошибки ввода. Остановка — `Ctrl+C`.

Для консольного примера выполните `npm run planner:demo`. Афиша, сохранение в облаке и функции MAX проверяются в рабочем боте, а не в этих примерах.

## Разработка с внешними сервисами

1. Заполните `.env.local` по README.
2. Подключите отдельную PostgreSQL через `DATABASE_URL`; при необходимости настройте TLS по [инструкции](configuration.md#база-вне-compose).
3. Запустите `npm run dev`.

Vite работает на `5173`, API — на `3000`. Для входа через MAX нужен публичный HTTPS-адрес клиентского сервера с проксированием `/api` и привязанное мини-приложение. Не направляйте рабочий webhook на процесс разработки.

## Автоматические проверки

```sh
npm run check
npm run planner:test
node --import tsx scripts/api-contract.mts --check
node scripts/dependency-inventory.mjs --check
```

`check` запускает типизацию, TypeScript-тесты и сборку. `planner:test` проверяет Python. Контракт сверяется с генератором; проверки лицензий сверяют сохранённые сведения с зависимостями.

SQL-тестам нужна отдельная пустая PostgreSQL в `TEST_DATABASE_URL`. Без этой переменной они пропускаются. CI создаёт такую базу; настройки доступны в [.github/workflows/ci.yml](../.github/workflows/ci.yml). Рабочую базу для тестов использовать нельзя.

Длительная проверка фонового расчёта включается через `RUN_LONG_ASYNC_ACCEPTANCE=1` вместе с `TEST_DATABASE_URL`. Она проверяет локальную обработку, а не доставку заданий Yandex Cloud.

## Обновление контракта API

Отредактируйте схемы в `src/shared/` и описания в `scripts/api-contract.mts`, затем выполните:

```sh
node --import tsx scripts/api-contract.mts --write
npm exec -- vitest run src/server/submission-api-contract.test.ts
```

`openapi.yaml` и `DATA-API.yaml` генерируются вместе. Их JSON-запись допустима в YAML 1.2; вручную менять сгенерированные файлы не нужно.
