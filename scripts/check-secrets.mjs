// Scan Git history and the exact non-ignored working-tree source candidates.
// Private env/logs are never copied. Gitleaks is pinned, offline and fully redacted.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const output = resolve(root, 'output/playwright/secret-scan');
const image = 'zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
mkdirSync(output, { recursive: true });
const source = mkdtempSync(resolve(output, 'source-'));
function inside(parent, path) {
  const rel = relative(parent, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) throw new Error('Cannot enumerate source files safely.');
  return result.stdout;
}
function scan(mode, directory, name) {
  const report = resolve(output, `${name}.json`);
  if (existsSync(report)) rmSync(report);
  const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL', '--read-only',
    '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp',
    '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=/source',
    '--mount', `type=bind,source=${directory},target=/source,readonly`,
    '--mount', `type=bind,source=${output},target=/reports`, image, mode, '/source',
    ...(mode === 'git' ? ['--log-opts=--all'] : []), '--ignore-gitleaks-allow', '--redact=100',
    '--no-banner', '--no-color', '--log-level', 'error', '--timeout', '120',
    '--report-format', 'json', '--report-path', `/reports/${name}.json`],
  { cwd: root, encoding: 'utf8', timeout: 180_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
  if (![0, 1].includes(result.status) || !existsSync(report)) {
    // A clean runner can fail before gitleaks starts. Expose only fixed categories
    // and process metadata; Docker/gitleaks text can contain scanned source data.
    const diagnostic = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
    const reason = /toomanyrequests|too many requests|rate limit/i.test(diagnostic) ? 'registry-rate-limit'
      : /manifest unknown|no matching manifest|pull access denied|unauthorized|failed to resolve reference/i.test(diagnostic) ? 'image-unavailable'
      : /permission denied|operation not permitted|dubious ownership/i.test(diagnostic) ? 'filesystem-permission'
      : /cannot connect to the docker daemon|is the docker daemon running/i.test(diagnostic) ? 'docker-unavailable'
      : /unknown flag|unknown command/i.test(diagnostic) ? 'unsupported-command'
      : 'unclassified';
    console.error(JSON.stringify({ scope: name, status: result.status, signal: result.signal,
      process_error: result.error?.code ?? null, report_exists: existsSync(report), reason }));
    throw new Error(`Secret scan ${name} did not complete; raw output suppressed.`);
  }
  const findings = JSON.parse(readFileSync(report, 'utf8'));
  if (!Array.isArray(findings) || (result.status === 1 && !findings.length)) throw new Error(`Invalid secret scan report: ${name}.`);
  console.log(JSON.stringify({ scope: name, findings: findings.length, locations: findings.map(item => ({
    file: item.File, line: item.StartLine, rule: item.RuleID,
  })) }));
  return findings.length;
}
try {
  const files = [...new Set(git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))];
  let copied = 0;
  for (const file of files) {
    const from = resolve(root, file), to = resolve(source, file);
    if (!inside(root, from) || !inside(source, to)) throw new Error('Invalid source path.');
    if (!existsSync(from)) continue; // A tracked deletion is absent from the submission.
    if (!lstatSync(from).isFile() || !inside(root, realpathSync(from))) throw new Error(`Non-regular source candidate: ${file}`);
    if (/(^|\/)\.env(?:\.|$)/u.test(file) && !file.endsWith('.env.example')) throw new Error('A private env file is a source candidate.');
    mkdirSync(dirname(to), { recursive: true }); cpSync(from, to); copied++;
  }
  const history = scan('git', root, 'history');
  const current = scan('dir', source, 'working-tree');
  console.log(JSON.stringify({ scanner: image, source_files: copied, history_findings: history, working_tree_findings: current }));
  if (history + current) process.exitCode = 1;
} finally {
  // Delete only the generated scan copy, after checking its resolved workspace boundary.
  const actual = realpathSync(source);
  if (!inside(realpathSync(output), actual) || !actual.split(sep).at(-1)?.startsWith('source-')) throw new Error('Unsafe scan cleanup target.');
  rmSync(actual, { recursive: true });
}
