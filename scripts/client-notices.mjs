// Preserve upstream notices for the browser libraries and their runtime dependencies.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8')).packages;
const visited = new Map();
const missingNotices = [];
function dependencyPath(parent, name) {
  let current = parent;
  while (current) {
    const candidate = `${current}/node_modules/${name}`;
    if (lock[candidate]) return candidate;
    const index = current.lastIndexOf('/node_modules/');
    current = index < 0 ? '' : current.slice(0, index);
  }
  const candidate = `node_modules/${name}`;
  return lock[candidate] ? candidate : null;
}
function visit(path) {
  if (visited.has(path)) return;
  const directory = resolve(root, path);
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.version !== lock[path]?.version) throw new Error(`Installed version differs from lockfile: ${path}`);
  const files = readdirSync(directory).filter(file => /^(LICEN[CS]E|COPYING|NOTICE)([.\-]|$)/iu.test(file) && statSync(resolve(directory, file)).isFile());
  const notices = files.sort().map(file => `${file}\n${readFileSync(resolve(directory, file), 'utf8').trim()}`);
  const repository = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (!notices.length) {
    if (pkg.name !== '@maxhub/max-ui' || pkg.version !== '0.5.0' || pkg.license !== 'MIT') {
      throw new Error(`Review missing upstream notice: ${pkg.name}@${pkg.version}`);
    }
    missingNotices.push(`${pkg.name}@${pkg.version}`);
  }
  visited.set(path, [
    `${pkg.name} ${pkg.version}`, `Declared license: ${pkg.license}`, `Upstream: ${repository ?? pkg.homepage ?? 'See package-lock.json'}`,
    ...(notices.length ? notices : [
      `Author from package metadata: ${typeof pkg.author === 'string' ? pkg.author : pkg.author?.name ?? 'not supplied'}`,
      'This release declares MIT in package.json but provides no separate LICENSE or copyright notice in its npm package or tagged source. This metadata is preserved without inventing an upstream copyright statement.',
    ]),
  ].join('\n\n'));
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).sort()) {
    const child = dependencyPath(path, name);
    if (child) visit(child);
    else if (!pkg.peerDependenciesMeta?.[name]?.optional) throw new Error(`Missing runtime dependency: ${pkg.name} -> ${name}`);
  }
}
for (const name of ['@2gis/mapgl', '@maxhub/max-ui', 'react', 'react-dom']) visit(`node_modules/${name}`);
const content = 'V-MAX: third-party browser library notices\nGenerated from installed packages checked against package-lock.json, including transitive type definitions.\nService/data/brand usage terms are separate; see THIRD_PARTY_NOTICES.md in the source distribution.\n\n'
  + [...visited.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, notice]) => notice).join('\n\n' + '='.repeat(72) + '\n\n') + '\n';
const target = resolve(root, 'public/third-party-notices.txt');
if (process.argv.includes('--check')) {
  if (!existsSync(target) || readFileSync(target, 'utf8').replace(/\r\n/g, '\n') !== content.replace(/\r\n/g, '\n')) throw new Error('Browser notices are stale; run node scripts/client-notices.mjs.');
} else writeFileSync(target, content);
console.log(JSON.stringify({ browser_packages: visited.size, missing_upstream_notice: missingNotices, checked: process.argv.includes('--check') }));
