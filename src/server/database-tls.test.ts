import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PeerCertificate } from 'node:tls';
import { expect, it } from 'vitest';
import { loadDatabaseCa, planningPoolConfig, requireDatabaseTls } from './database-tls.js';

// This fixture checks loading, not cryptographic trust (covered by local PG TLS test).
const pem = '-----BEGIN CERTIFICATE-----\nloader-test-only\n-----END CERTIFICATE-----';
it('requires production TLS except for the explicitly enabled local Compose service', () => {
  expect(requireDatabaseTls(true, false, 'postgres://database/db')).toBe(true);
  expect(requireDatabaseTls(true, true, 'postgres://database/db')).toBe(false);
  expect(requireDatabaseTls(false, false, 'postgres://localhost/db')).toBe(false);
  expect(() => requireDatabaseTls(true, true, 'postgres://10.130.0.19/db')).toThrow('local Compose');
});
it('loads a multiline CA directly without creating a temporary file', async () => {
  expect(await loadDatabaseCa({ pem: `\n${pem}\n`, required: true })).toBe(pem);
});
it('retains CA file support', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maxbot-ca-'));
  try {
    const path = join(dir, 'ca.crt'); await writeFile(path, pem);
    expect(await loadDatabaseCa({ path, required: true })).toBe(pem);
  } finally { await rm(dir, { recursive: true }); }
});
it('fails closed for missing, conflicting, private-key or unreadable CA configuration', async () => {
  await expect(loadDatabaseCa({ required: true })).rejects.toThrow('required');
  await expect(loadDatabaseCa({ pem, path: 'any', required: true })).rejects.toThrow('not both');
  await expect(loadDatabaseCa({ pem: '-----BEGIN PRIVATE KEY-----', required: true })).rejects.toThrow('public PEM');
  await expect(loadDatabaseCa({ path: '/nonexistent/maxbot-ca.crt', required: true })).rejects.toThrow();
  expect(await loadDatabaseCa({ required: false })).toBeUndefined();
});
it('requires verified TLS with the supplied CA and blocks URL overrides', () => {
  const url = 'postgres://user:password@10.130.0.19:5432/maxbot';
  const ssl = planningPoolConfig(url, pem).ssl;
  expect(ssl).toMatchObject({ ca: pem, rejectUnauthorized: true });
  if (!ssl || typeof ssl !== 'object' || !ssl.checkServerIdentity) throw new Error('TLS identity check missing');
  const correct = { subjectaltname: 'IP Address:10.130.0.19' } as PeerCertificate;
  const incorrect = { subjectaltname: 'IP Address:10.130.0.20' } as PeerCertificate;
  // pg passes a socket without a hostname for IP connections; ignore Node's
  // default "localhost" and verify the URL host against the certificate SAN.
  expect(ssl.checkServerIdentity('localhost', correct)).toBeUndefined();
  expect(ssl.checkServerIdentity('localhost', incorrect)).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey', 'ssl']) {
    expect(() => planningPoolConfig(`${url}?${key}=disable`, pem)).toThrow('Remove SSL');
  }
  expect(planningPoolConfig(url).ssl).toBeUndefined();
});
