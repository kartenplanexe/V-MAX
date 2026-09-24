import { InitialIntentError } from './intent-start.js';

// Reviewed 2026-09-24: https://aistudio.yandex.ru/ru/docs/ai-studio/pricing
// Conservative reservation: full 65,536 input + 4,096 output; NOT a billing guarantee.
const callReserveRub = 65_536 * 0.1 / 1000 + 4096 * 0.2 / 1000;

export class YandexIntentClient {
  #calls = 0;
  #reservedRub = 0;
  readonly #fetch: typeof fetch;
  constructor(readonly options: { apiKey: string; folderId: string; maxCalls: number; maxEstimatedRub: number; fetchImpl?: typeof fetch }) {
    if (!options.apiKey.trim() || !/^[a-zA-Z0-9_-]+$/u.test(options.folderId) ||
        !Number.isInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 100 ||
        !Number.isFinite(options.maxEstimatedRub) || options.maxEstimatedRub <= 0)
      throw new InitialIntentError('INTENT_CONFIG_REQUIRED', 503);
    this.#fetch = options.fetchImpl ?? fetch;
  }
  async generate(request: Record<string, unknown>): Promise<unknown> {
    if (this.#calls >= this.options.maxCalls || this.#reservedRub + callReserveRub > this.options.maxEstimatedRub)
      throw new InitialIntentError('INTENT_RUN_LIMIT', 429);
    const body = JSON.stringify({ messages: request.messages, response_format: request.response_format,
      model: `gpt://${this.options.folderId}/aliceai-llm-flash`, temperature: 0, max_tokens: 4096, stream: false, store: false });
    if (Buffer.byteLength(body) > 512 * 1024) throw new InitialIntentError('INTENT_INPUT_TOO_LARGE', 413);
    // Reserve synchronously, including failed/time-out attempts: no optimistic refund or retry.
    this.#calls++; this.#reservedRub += callReserveRub;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.#fetch('https://ai.api.cloud.yandex.net/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Api-Key ${this.options.apiKey}`,
          'x-folder-id': this.options.folderId, 'OpenAI-Project': this.options.folderId, 'x-data-logging-enabled': 'false' }, body,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel(); throw new InitialIntentError('INTENT_PROVIDER_FAILED', 502);
      }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 512 * 1024) { await reader.cancel(); throw new InitialIntentError('INTENT_PROVIDER_FAILED', 502); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const choice = data.choices?.[0];
      if (choice?.finish_reason !== 'stop') throw new InitialIntentError('INTENT_TRUNCATED', 502);
      if (choice.message?.refusal || typeof choice.message?.content !== 'string') throw new InitialIntentError('INTENT_PROVIDER_FAILED', 502);
      return JSON.parse(choice.message.content);
    } catch (error) {
      if (error instanceof InitialIntentError) throw error;
      throw new InitialIntentError('INTENT_PROVIDER_FAILED', 502);
    } finally { clearTimeout(timer); }
  }
}
