import { loadEnvFile } from 'node:process';

function loadLocalEnvironment() {
  if (process.env.NODE_ENV === 'production') return;

  try {
    loadEnvFile('.env.local');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string) {
  if (!value) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

loadLocalEnvironment();

export const config = {
  host: process.env.HOST?.trim() || '0.0.0.0',
  initDataTtlSeconds: parsePositiveInteger(
    process.env.MAX_INIT_DATA_TTL_SECONDS,
    3600,
    'MAX_INIT_DATA_TTL_SECONDS',
  ),
  maxBotToken: process.env.MAX_BOT_TOKEN?.trim() || '',
  port: parsePositiveInteger(process.env.PORT, 3000, 'PORT'),
  publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() || '',
} as const;
