import { copyFile, mkdir } from 'node:fs/promises';
const destination = new URL('../dist/server/server/intent/', import.meta.url);
await mkdir(destination, { recursive: true });
for (const name of ['intent-parser-response-v0.2.schema.json', 'intent-parser-system-v0.8.md', 'time-default-policy.v1.json']) {
  await copyFile(new URL('../src/server/intent/' + name, import.meta.url), new URL(name, destination));
}
await copyFile(new URL('../src/server/planning-schema.sql', import.meta.url), new URL('../dist/server/server/planning-schema.sql', import.meta.url));
