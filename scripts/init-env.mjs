import { constants } from 'node:fs';
import { access, chmod, copyFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const examplePath = resolve(repositoryRoot, '.env.example');
const localPath = resolve(repositoryRoot, '.env.local');

try {
  await access(localPath, constants.F_OK);
  console.log('.env.local already exists; it was not changed.');
  process.exit(0);
} catch {
  // The local file does not exist yet.
}

await copyFile(examplePath, localPath, constants.COPYFILE_EXCL);

if (process.platform !== 'win32') {
  await chmod(localPath, 0o600);
}

console.log('Created .env.local from .env.example. Add MAX_BOT_TOKEN locally.');

