// Inventory the exact lockfile, including optional platforms and build tools.
// License identifiers are upstream metadata, not a grant for external API data.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bytes = readFileSync(resolve(root, 'package-lock.json'));
const canonicalLock = bytes.toString('utf8').replace(/\r\n/g, '\n');
const lock = JSON.parse(bytes);
const packages = Object.entries(lock.packages).filter(([path]) => path).map(([path, item]) => {
  if (!item.version || typeof item.license !== 'string' || !item.license.trim()) {
    throw new Error(`Missing version/license metadata: ${path}`);
  }
  return {
    path, name: item.name ?? path.split('node_modules/').at(-1), version: item.version,
    license: item.license, development: !!item.dev, optional: !!item.optional,
    os: item.os ?? null, cpu: item.cpu ?? null,
    source: item.resolved ?? null, integrity: item.integrity ?? null,
  };
}).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const report = JSON.stringify({
  schema_version: 1,
  scope: 'All npm lockfile packages, including development and optional platform packages; not the final container OS inventory.',
  lockfile_hash_encoding: 'UTF-8 with LF line endings',
  lockfile_sha256: createHash('sha256').update(canonicalLock).digest('hex'), packages,
}, null, 2) + '\n';
const target = resolve(root, 'third-party/npm-lock-inventory.json');
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== report) throw new Error('Dependency inventory is stale; run node scripts/dependency-inventory.mjs.');
  const python = JSON.parse(readFileSync(resolve(root, 'third-party/python-linux-runtime.json'), 'utf8'));
  const pythonLock = readFileSync(resolve(root, 'planner/uv.lock'), 'utf8').replace(/\r\n/g, '\n');
  if (python.lockfile_sha256 !== createHash('sha256').update(pythonLock).digest('hex')) {
    throw new Error('Python runtime inventory is stale; regenerate it in the final Linux image.');
  }
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, report);
}
console.log(JSON.stringify({ npm_packages: packages.length, inventory: 'third-party/npm-lock-inventory.json', checked: process.argv.includes('--check') }));
