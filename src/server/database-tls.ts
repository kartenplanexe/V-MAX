import { readFile } from 'node:fs/promises';
import { checkServerIdentity } from 'node:tls';
import type { PoolConfig } from 'pg';

export function requireDatabaseTls(production: boolean, allowLocalPlaintext: boolean, url: string) {
  if (!production) return false;
  if (allowLocalPlaintext) {
    if (new URL(url).hostname !== 'database') {
      throw new Error('Plaintext exception is restricted to the local Compose database service');
    }
    return false;
  }
  return true;
}

/** Lockbox can inject PEM directly; local development can still use a CA file. */
export async function loadDatabaseCa(options: { pem?: string; path?: string; required: boolean }) {
  const pem = options.pem?.trim();
  const path = options.path?.trim();
  if (pem && path) throw new Error('Set only DATABASE_CA_PEM or DATABASE_CA_PATH, not both');
  const ca = pem || (path ? (await readFile(path, 'utf8')).trim() : undefined);
  if (!ca) {
    if (options.required) throw new Error('A PostgreSQL CA certificate is required in production');
    return undefined;
  }
  if (!ca.includes('-----BEGIN CERTIFICATE-----') || ca.includes('PRIVATE KEY')) {
    throw new Error('PostgreSQL CA must contain a public PEM certificate, not a private key');
  }
  // Actual certificate chain/host validation is performed by Node TLS on connection.
  return ca;
}

export function planningPoolConfig(connectionString: string, ca?: string): PoolConfig {
  let ssl: PoolConfig['ssl'];
  if (ca) {
    const url = new URL(connectionString);
    // node-postgres URL parameters can replace the explicit ssl object, losing the CA.
    if ([...url.searchParams.keys()].some(key => key.toLowerCase().startsWith('ssl'))) {
      throw new Error('Remove SSL URL parameters; configure PostgreSQL TLS through the CA setting');
    }
    // pg upgrades an already-connected socket to TLS. For an IP address it does not
    // set servername, so Node would validate the certificate against "localhost".
    // Keep CA verification and verify the actual host from DATABASE_URL instead.
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    ssl = { ca, rejectUnauthorized: true,
      checkServerIdentity: (_servername, certificate) => checkServerIdentity(hostname, certificate) };
  }
  return { connectionString, max: 6, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000,
    ...(ssl ? { ssl } : {}) };
}
