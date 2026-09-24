// Isolated integration check: no cloud access, no production keys, no exposed ports.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = mkdtempSync(join(tmpdir(), 'maxbot-pg-check-'));
const name = `maxbot-pg-check-${randomBytes(5).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const openssl = process.env.OPENSSL_BIN ?? (process.platform === 'win32'
  ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
function run(bin, args, expectSuccess = true) {
  const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 120_000 });
  if (result.error || (expectSuccess && result.status !== 0)) {
    // Never include generated credentials or full child command lines in errors.
    throw new Error(`${bin} failed: ${String(result.error ?? result.stderr).replaceAll(password, '[REDACTED]')}`);
  }
  return result;
}
const docker = (args, ok = true) => run('docker', args, ok);
const query = (sql, tls = 'verify-full', ok = true, host = '127.0.0.1') => docker([
  'exec', '-e', `PGPASSWORD=${password}`, name, 'psql',
  `host=${host} hostaddr=127.0.0.1 user=maxbot dbname=maxbot sslmode=${tls} sslrootcert=/certs/ca.crt connect_timeout=2`,
  '-v', 'ON_ERROR_STOP=1', '-Atqc', sql,
], ok);
let created = false;
try {
  for (const folder of ['certs', 'config', 'init']) mkdirSync(join(fixture, folder));
  for (const file of ['postgresql.conf', 'pg_hba.conf']) copyFileSync(join(here, file), join(fixture, 'config', file));
  run(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', join(fixture, 'ca.key'), '-out', join(fixture, 'certs/ca.crt'),
    '-subj', '/CN=local-verification-ca', '-addext', 'basicConstraints=critical,CA:TRUE']);
  run(openssl, ['req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(fixture, 'certs/server.key'), '-out', join(fixture, 'server.csr'), '-subj', '/CN=maxbot-db']);
  writeFileSync(join(fixture, 'server.ext'), 'basicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:maxbot-db\n');
  run(openssl, ['x509', '-req', '-in', join(fixture, 'server.csr'),
    '-CA', join(fixture, 'certs/ca.crt'), '-CAkey', join(fixture, 'ca.key'), '-CAcreateserial',
    '-out', join(fixture, 'certs/server.crt'), '-days', '1', '-extfile', join(fixture, 'server.ext')]);
  writeFileSync(join(fixture, 'init/01-app.sql'), `CREATE ROLE maxbot LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${password}';\nCREATE DATABASE maxbot OWNER maxbot;\nREVOKE ALL ON DATABASE maxbot FROM PUBLIC;\n`);
  docker(['create', '--name', name, '--network', 'none', '--memory', '1g',
    '--mount', `type=bind,src=${fixture},dst=/fixture,readonly`,
    '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
    '--entrypoint', 'sh', 'postgres:17-alpine', '-ec',
    'cp -R /fixture/certs /certs; cp -R /fixture/config /config; cp /fixture/init/01-app.sql /docker-entrypoint-initdb.d/01-app.sql; chmod 755 /certs /config; chmod 644 /certs/*.crt /config/*; chown postgres:postgres /certs/server.key; chmod 600 /certs/server.key; exec docker-entrypoint.sh postgres -c config_file=/config/postgresql.conf']);
  created = true;
  docker(['start', name]);
  let ready = false;
  for (let i = 0; i < 45; i++) {
    if (query('SELECT 1', 'verify-full', false).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(ready, 'PostgreSQL must initialize and accept verified TLS');
  assert.equal(query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()').stdout.trim(), 't');
  assert.notEqual(query('SELECT 1', 'disable', false).status, 0, 'plaintext must be rejected');
  assert.notEqual(query('SELECT 1', 'verify-full', false, 'wrong.example').status, 0, 'wrong certificate hostname must be rejected');
  assert.equal(query("SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user").stdout.trim(), 'f|f|f');
  assert.notEqual(query('CREATE ROLE forbidden', 'verify-full', false).status, 0);
  query('CREATE TABLE persistence_check(value int); INSERT INTO persistence_check VALUES (42)');
  docker(['restart', name]);
  ready = false;
  for (let i = 0; i < 20; i++) {
    const result = query('SELECT value FROM persistence_check', 'verify-full', false);
    if (result.status === 0 && result.stdout.trim() === '42') { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert(ready, 'Data must survive container restart');
  console.log('PASS: verified TLS, plaintext rejected, wrong hostname rejected, non-superuser role, DDL restrictions, persistence after restart.');
  console.log('Not tested: Ubuntu package install, real VM permissions/bind mounts, Yandex security group/VPC, backups, cloud app integration.');
} finally {
  // Only the unique, test-owned container and temporary directory are removed.
  if (created) docker(['rm', '-f', '-v', name]);
  rmSync(fixture, { recursive: true, force: true });
}
