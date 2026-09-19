import { readFile } from 'node:fs/promises';
import { request } from 'node:https';
import { dirname, resolve } from 'node:path';
import { getCACertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = resolve(repositoryRoot, '.env.local');
const apiUrl = 'https://platform-api2.max.ru/me';
const trustedCaCertificates = [
  ...new Set([...getCACertificates('default'), ...getCACertificates('system')]),
];

function parseEnv(source) {
  const parsed = {};

  for (const [index, originalLine] of source.split(/\r?\n/u).entries()) {
    const line = originalLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) {
      throw new Error(`Invalid .env.local syntax at line ${index + 1}.`);
    }

    const [, key] = match;
    let value = match[2].trim();

    if (Object.hasOwn(parsed, key)) {
      throw new Error(`Duplicate ${key} entry in .env.local.`);
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/u, '').trim();
    }

    parsed[key] = value;
  }

  return parsed;
}

function getBotProfile(token) {
  return new Promise((resolveRequest, rejectRequest) => {
    const requestHandle = request(
      apiUrl,
      {
        ca: trustedCaCertificates,
        family: 4,
        headers: {
          Accept: 'application/json',
          Authorization: token,
        },
        method: 'GET',
      },
      (response) => {
        const chunks = [];
        let receivedBytes = 0;

        response.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (receivedBytes > 1_000_000) {
            requestHandle.destroy(new Error('MAX API response exceeded 1 MB.'));
            return;
          }
          chunks.push(chunk);
        });

        response.on('end', () => {
          const status = response.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString('utf8');

          if (status < 200 || status >= 300) {
            rejectRequest(
              new Error(`MAX API returned HTTP ${status}. The token was not printed.`),
            );
            return;
          }

          try {
            resolveRequest({ bot: JSON.parse(body), status });
          } catch {
            rejectRequest(new Error('MAX API returned invalid JSON.'));
          }
        });
      },
    );

    requestHandle.setTimeout(10_000, () => {
      requestHandle.destroy(new Error('MAX API request timed out.'));
    });
    requestHandle.on('error', rejectRequest);
    requestHandle.end();
  });
}

async function main() {
  let localEnv;
  try {
    localEnv = parseEnv(await readFile(envPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('Missing .env.local. Run: node scripts/init-env.mjs');
    }
    throw error;
  }

  // Process environment wins in CI/hosting; .env.local is the local default.
  const token = process.env.MAX_BOT_TOKEN?.trim() || localEnv.MAX_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error('MAX_BOT_TOKEN is empty in .env.local.');
  }

  // MAX requires the Ministry of Digital Development CA. Keep Node's bundled
  // roots and add the operating system trust store instead of disabling TLS.
  const { bot, status } = await getBotProfile(token);
  const safeResult = {
    http_status: status,
    user_id: bot.user_id,
    name: bot.name,
    username: bot.username,
    is_bot: bot.is_bot,
    checked_at: new Date().toISOString(),
  };

  console.log(JSON.stringify(safeResult, null, 2));
}

main().catch((error) => {
  console.error(`Smoke-test failed: ${error.message}`);
  process.exitCode = 1;
});
