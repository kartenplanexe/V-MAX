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
  databaseUrl: process.env.DATABASE_URL?.trim() || '',
  databaseCaPath: process.env.DATABASE_CA_PATH?.trim() || '',
  databaseCaPem: process.env.DATABASE_CA_PEM?.trim() || '',
  databaseAllowLocalPlaintext: process.env.DATABASE_ALLOW_LOCAL_PLAINTEXT === 'true',
  yandexApiKey: process.env.YANDEX_API_KEY?.trim() || '',
  yandexFolderId: process.env.YANDEX_FOLDER_ID?.trim() || '',
  dgisMapglApiKey: process.env.DGIS_MAPGL_API_KEY?.trim() || '',
  dgisPlacesApiKey: process.env.DGIS_PLACES_API_KEY?.trim() || '',
  dgisRoutingApiKey: process.env.DGIS_ROUTING_API_KEY?.trim() || '',
  dgisBackupApiKey: process.env.DGIS_BACKUP_API_KEY?.trim() || '',
  host: process.env.HOST?.trim() || '0.0.0.0',
  isProduction: process.env.NODE_ENV === 'production',
  initDataTtlSeconds: parsePositiveInteger(
    process.env.MAX_INIT_DATA_TTL_SECONDS,
    3600,
    'MAX_INIT_DATA_TTL_SECONDS',
  ),
  maxBotToken: process.env.MAX_BOT_TOKEN?.trim() || '',
  maxBotUsername: process.env.MAX_BOT_USERNAME?.trim() || 't801_hakaton_max_bot',
  port: parsePositiveInteger(process.env.PORT, 3000, 'PORT'),
  publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() || '',
} as const;
