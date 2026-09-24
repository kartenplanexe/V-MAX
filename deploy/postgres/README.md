# PostgreSQL 17 на отдельной ВМ Yandex Cloud

Первичная установка на выделенную Ubuntu 22.04/24.04, 2 ГБ RAM, диск 10 ГБ.
Существующий Serverless Container и его URL не меняются. Это НЕ полный production rollout.

## Запуск

Из PowerShell на компьютере разработчика:

```powershell
cd "C:\Users\TitanPC\PycharmProjects\V-MAX"
scp -i "$env:USERPROFILE\.ssh\maxbot-db" -r .\deploy\postgres yc-user@158.160.195.62:~/
ssh -i "$env:USERPROFILE\.ssh\maxbot-db" yc-user@158.160.195.62
```

На ВМ (не в PowerShell):

```bash
sed -i 's/\r$//' ~/postgres/setup.sh
sudo bash ~/postgres/setup.sh
```

Скрипт требует минимум 3 ГиБ свободного места перед установкой; это защитный порог,
не обещание достаточности диска на весь срок работы. Проверяет приватный IP,
останавливается при существующем `/opt/maxbot-postgres` или контейнере. После ошибки
не удаляйте каталог/данные и не создавайте БД заново: сначала выясните причину.
Не запускайте на ВМ с другими PostgreSQL-сервисами.

Устанавливает Docker из репозиториев Ubuntu, фиксирует скачанный postgres:17-alpine
по digest в `/opt/maxbot-postgres/image.txt`. Данные — bind mount на постоянном диске
`/opt/maxbot-postgres/data`, не writable layer контейнера. Ограничение RAM 1 ГиБ,
Docker-логи 3×10 МБ; `max_wal_size` — мягкий ориентир, не жёсткая квота размера БД/WAL.
Не запускает prune, не меняет SG и не создаёт платные облачные ресурсы.

Приложение использует отдельную роль maxbot без superuser/createdb/createrole,
но с правом создавать собственные таблицы для текущих миграций. Администрирование —
через SSH и `sudo docker exec -u postgres maxbot-postgres psql`.
Приватный IP:5432 публикуется только с TLS; HBA допускает maxbot из
`198.19.0.0/16` и внутренний loopback для проверки. На SG также необходимо разрешить
TCP/5432 только от Serverless `198.19.0.0/16`, SSH только с доверенного IPv4/32.
Default/open SG не добавлять. Проверку с реального Serverless выполнить отдельно.

## Секреты и TLS

- Пароли создаются на ВМ и не выводятся. `private/connection.env` содержит DATABASE_URL.
- `certs/ca.crt` — публичный сертификат доверия; его можно доставить приложению.
- `certs/server.key`, `private/ca.key`, файлы паролей — секреты, не пересылать в чат/Git.
- CA private key пока root-only на ВМ; перед выпуском перенести в защищённое offline
  хранилище владельца, проверить копию и только затем удалить серверную копию.
- Сертификат сервера на 365 дней включает приватный IP и loopback SAN. Смена приватного
  IP требует перевыпуска. CA на 730 дней. Продление и оповещения ещё не автоматизированы.
- В Node использовать DATABASE_CA_PATH с доставленным CA и проверкой сертификата.
  Не добавлять `sslmode` в DATABASE_URL: параметры строки pg могут перекрыть явный TLS config.
  Не использовать `rejectUnauthorized:false`.

## Проверки и оставшиеся действия

Локальная изолированная проверка: `node deploy/postgres/verify-local.mjs`.
Нужны Docker с образом postgres:17-alpine и OpenSSL (на Windows — Git for Windows,
либо OPENSSL_BIN). Тест создаёт только собственный временный контейнер без сети,
портов и облачных ключей, удаляет его и тестовый том после проверки. Он проверяет
реальный PostgreSQL с этими конфигами, но не Ubuntu apt/SG/сетевое подключение ВМ.

`POSTGRES_SETUP_OK` означает только локальную готовность: TLS verify-full работает,
нешифрованный вход отклоняется; роль приложения не superuser. Это не E2E MAX.

До подключения реальных пользователей обязательны: резервные копии **вне ВМ** в РФ
с ограниченным retention и проверкой восстановления, мониторинг свободного места
и срока сертификата, перенос CA private key offline, доставка CA и DATABASE_URL
в существующий Serverless Container через закрытую конфигурацию/Lockbox, подключение
его к той же VPC, ограничение масштабирования согласно max_connections=40
(приложение имеет pool max=6), проверка TLS/миграций/перезапуска из облака.
Локальный dump на том же диске НЕ считается защитой от потери ВМ/диска.

Обновление 24.09: владелец явно отложил off-VM backups для текущего этапа хакатона
и принял риск отсутствия восстановления при потере диска. Это не требование
организаторов и не блокирует подготовку подключения. Для облака добавлена
альтернатива CA-файлу: DATABASE_CA_PEM из Lockbox. Инструкция подготовки — в
основном README, scripts/configure-yandex-secrets.mjs.

Источники:
- https://www.postgresql.org/docs/17/ssl-tcp.html
- https://www.postgresql.org/docs/17/auth-pg-hba-conf.html
- https://hub.docker.com/_/postgres
- https://yandex.cloud/ru/docs/serverless-containers/concepts/networking
