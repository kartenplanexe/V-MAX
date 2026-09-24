#!/usr/bin/env bash
# First installation on a dedicated Ubuntu VM. Never reset an existing database.
set -Eeuo pipefail
umask 077
trap 'printf "Setup stopped at line %s. Existing files/data were preserved; do not delete them to retry.\n" "$LINENO" >&2' ERR

[[ $EUID -eq 0 ]] || { echo 'Run with sudo bash setup.sh'; exit 1; }
source /etc/os-release
[[ $ID == ubuntu && ( $VERSION_ID == 22.04 || $VERSION_ID == 24.04 ) ]] || {
  echo 'This installer requires Ubuntu 22.04 or 24.04.'; exit 1;
}
src=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
base=/opt/maxbot-postgres
container=maxbot-postgres
[[ ! -e $base ]] || { echo "$base already exists. Stop: inspect before continuing."; exit 1; }
for file in postgresql.conf pg_hba.conf; do
  [[ -s $src/$file ]] || { echo "Missing $file"; exit 1; }
done
if command -v docker >/dev/null && docker container inspect "$container" >/dev/null 2>&1; then
  echo 'Container already exists. No changes made.'; exit 1
fi
db_ip=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')
IFS=. read -r oct1 oct2 oct3 oct4 <<< "$db_ip"
if [[ $oct1 != 10 && ! ( $oct1 == 192 && $oct2 == 168 ) && ! ( $oct1 == 172 && $oct2 -ge 16 && $oct2 -le 31 ) ]]; then
  echo 'Could not determine a private IPv4; refusing to expose PostgreSQL.'; exit 1
fi
available_kb=$(df -Pk /opt | awk 'NR==2 {print $4}')
(( available_kb >= 3 * 1024 * 1024 )) || { echo 'Less than 3 GiB free; installation stopped.'; exit 1; }

echo 'Installing Docker from Ubuntu repositories, OpenSSL and CA certificates...'
apt-get update
if command -v docker >/dev/null; then
  apt-get install -y ca-certificates openssl
else
  apt-get install -y docker.io ca-certificates openssl
fi
systemctl enable --now docker
docker pull postgres:17-alpine
image=$(docker image inspect postgres:17-alpine --format '{{index .RepoDigests 0}}')
[[ $image == postgres@sha256:* ]] || { echo 'Image digest not resolved.'; exit 1; }
pg_uid=$(docker run --rm --network none "$image" id -u postgres)
pg_gid=$(docker run --rm --network none "$image" id -g postgres)

install -d -m 700 "$base" "$base/data" "$base/private" "$base/secrets"
install -d -m 755 "$base/config" "$base/certs" "$base/init"
install -m 644 "$src/postgresql.conf" "$src/pg_hba.conf" "$base/config/"
# SCP/Windows checkouts may carry CRLF.
sed -i 's/\r$//' "$base/config/postgresql.conf" "$base/config/pg_hba.conf"
printf '%s\n' "$image" > "$base/image.txt"
openssl rand -hex 32 > "$base/secrets/admin-password"
openssl rand -hex 32 > "$base/private/app-password"
# The entrypoint reads the administrator password after switching to postgres.
chown "$pg_uid:$pg_gid" "$base/secrets/admin-password"
chmod 400 "$base/secrets/admin-password"
chown "root:$pg_gid" "$base/secrets"
chmod 750 "$base/secrets"

echo 'Creating a private CA and a TLS server certificate...'
openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 730 \
  -keyout "$base/private/ca.key" -out "$base/certs/ca.crt" \
  -subj '/CN=maxbot-postgres-private-ca' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -new -newkey rsa:3072 -nodes \
  -keyout "$base/certs/server.key" -out "$base/private/server.csr" \
  -subj '/CN=maxbot-db'
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:%s,IP:127.0.0.1,DNS:maxbot-db\n' "$db_ip" > "$base/private/server.ext"
openssl x509 -req -in "$base/private/server.csr" \
  -CA "$base/certs/ca.crt" -CAkey "$base/private/ca.key" -CAcreateserial \
  -out "$base/certs/server.crt" -days 365 -sha256 -extfile "$base/private/server.ext"
chown "$pg_uid:$pg_gid" "$base/certs/server.key"
chmod 600 "$base/certs/server.key"
chmod 644 "$base/certs/ca.crt" "$base/certs/server.crt"
openssl verify -CAfile "$base/certs/ca.crt" -verify_ip "$db_ip" "$base/certs/server.crt"

app_password=$(< "$base/private/app-password")
[[ $app_password =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid generated password'; exit 1; }
printf "CREATE ROLE maxbot LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '%s';\nCREATE DATABASE maxbot OWNER maxbot;\nREVOKE ALL ON DATABASE maxbot FROM PUBLIC;\n" "$app_password" > "$base/init/01-app.sql"
chmod 644 "$base/init/01-app.sql"
printf 'DATABASE_URL=postgres://maxbot:%s@%s:5432/maxbot\n' "$app_password" "$db_ip" > "$base/private/connection.env"
unset app_password

echo 'Starting PostgreSQL (bound only to the private IP)...'
docker run -d --name "$container" --restart unless-stopped \
  --memory 1g --memory-swap 1g --shm-size 128m \
  --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
  --publish "$db_ip:5432:5432" \
  --mount "type=bind,src=$base/data,dst=/var/lib/postgresql/data" \
  --mount "type=bind,src=$base/config,dst=/config,readonly" \
  --mount "type=bind,src=$base/certs,dst=/certs,readonly" \
  --mount "type=bind,src=$base/init,dst=/docker-entrypoint-initdb.d,readonly" \
  --mount "type=bind,src=$base/secrets,dst=/run/secrets,readonly" \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/admin-password \
  --env POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 \
  --health-cmd 'gosu postgres pg_isready -U postgres -d postgres' \
  --health-interval 10s --health-timeout 3s --health-retries 6 \
  "$image" postgres -c config_file=/config/postgresql.conf

ready=false
for ((i=0;i<60;i++)); do
  if docker exec -u postgres "$container" psql -U postgres -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname='maxbot'" 2>/dev/null | grep -qx 1; then
    # Temporary init server uses only a socket. Require the final TCP/TLS listener too.
    if docker exec -i -u postgres "$container" sh -c 'read -r PGPASSWORD; export PGPASSWORD; exec psql "host=127.0.0.1 user=maxbot dbname=maxbot sslmode=verify-full sslrootcert=/certs/ca.crt connect_timeout=3" -v ON_ERROR_STOP=1 -Atqc "SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()"' < "$base/private/app-password" 2>/dev/null | grep -qx t; then
      ready=true; break
    fi
  fi
  sleep 2
done
[[ $ready == true ]] || { echo 'Readiness failed. Inspect sudo docker logs --tail 50 maxbot-postgres locally; redact secrets before sharing.'; exit 1; }
# No longer mount an initialization password in the running container's init file.
printf '%s\n' '-- Initialization complete. Role password is retained only in the private credentials file.' > "$base/init/01-app.sql"
chmod 644 "$base/init/01-app.sql"
echo 'Checking rejection of unencrypted connections...'
if docker exec -i -u postgres "$container" sh -c 'read -r PGPASSWORD; export PGPASSWORD; exec psql "host=127.0.0.1 user=maxbot dbname=maxbot sslmode=disable connect_timeout=3" -Atqc "SELECT 1"' < "$base/private/app-password" >/dev/null 2>&1; then
  echo 'ERROR: unencrypted access unexpectedly succeeded.'; exit 1
fi
echo 'Checking application-role permissions...'
docker exec -u postgres "$container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "SELECT rolname,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname='maxbot'"
printf '\nPOSTGRES_SETUP_OK\nPrivate IP: %s\nTLS verify-full: OK\nPlaintext connection: rejected\nCredentials: %s/private/connection.env (do not share)\nCA certificate: %s/certs/ca.crt\n' "$db_ip" "$base" "$base"
echo 'NOT YET CONFIGURED: off-VM backups/restore drill, disk/expiry alerts, offline CA-key custody, Serverless integration.'
df -h /opt
