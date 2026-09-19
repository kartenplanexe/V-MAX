import staticPlugin from '@fastify/static';
import Fastify from 'fastify';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { ApiError, MaxAuthSuccess } from '../shared/auth.js';
import { config } from './config.js';
import { validateMaxInitData } from './max-init-data.js';

const AuthBodySchema = z.object({
  initData: z.string().min(1).max(16 * 1024),
});

const server = Fastify({
  bodyLimit: 32 * 1024,
  logger: {
    redact: {
      censor: '[REDACTED]',
      paths: ['req.headers.authorization', 'req.body.initData'],
    },
  },
});

server.addHook('onSend', async (_request, reply) => {
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Content-Type-Options', 'nosniff');
});

server.get('/api/health', async () => ({
  service: 'v-max',
  status: 'ok',
  version: '0.1.0',
}));

server.post<{ Reply: ApiError | MaxAuthSuccess }>('/api/auth/max', async (request, reply) => {
  if (!config.maxBotToken) {
    return reply.status(503).send({
      code: 'MAX_NOT_CONFIGURED',
      message: 'Проверка запуска MAX пока не настроена на сервере.',
      status: 'error',
    });
  }

  const parsedBody = AuthBodySchema.safeParse(request.body);
  if (!parsedBody.success) {
    return reply.status(400).send({
      code: 'INVALID_REQUEST',
      message: 'MAX не передал корректные данные запуска.',
      status: 'error',
    });
  }

  const validation = validateMaxInitData(parsedBody.data.initData, config.maxBotToken, {
    maxAgeSeconds: config.initDataTtlSeconds,
  });

  if (!validation.ok) {
    request.log.warn({ reason: validation.reason }, 'MAX init data validation failed');
    return reply.status(401).send({
      code: 'INVALID_MAX_INIT_DATA',
      message: 'Не удалось подтвердить запуск. Закройте mini-app и откройте его из чата MAX ещё раз.',
      status: 'error',
    });
  }

  return reply.send({
    authDate: validation.authDate,
    status: 'authenticated',
    user: {
      firstName: validation.user.first_name,
      id: validation.user.id,
      languageCode: validation.user.language_code,
    },
  });
});

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const clientDirectory = resolve(currentDirectory, '../../client');

if (existsSync(clientDirectory)) {
  await server.register(staticPlugin, {
    root: clientDirectory,
    wildcard: false,
  });

  server.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
      return reply.sendFile('index.html');
    }
    return reply.status(404).send({ code: 'NOT_FOUND', message: 'Ресурс не найден.', status: 'error' });
  });
}

try {
  await server.listen({ host: config.host, port: config.port });
} catch (error) {
  server.log.error(error);
  process.exitCode = 1;
}
