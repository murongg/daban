import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ModelApi } from '@daban/protocol';

export const name = 'daban-prompt-cache';

interface CacheConfig {
  api: ModelApi;
  baseURL: string;
  model: string;
  key: string;
}

export function promptCacheId(scope: {
  workspace: string;
  bot: string;
  provider: string;
  model: string;
  conversationId?: string;
  chatRevision?: number;
}) {
  // Persisted conversation identity, never the per-task directory, time or request ID.
  const identity = [
    'daban-prompt-v1',
    path.resolve(scope.workspace),
    scope.provider,
    scope.model,
    scope.bot,
    scope.conversationId ?? null,
    scope.conversationId ? null : (scope.chatRevision ?? 0),
  ];
  return `daban-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 48)}`;
}

async function unsupportedCacheKey(response: Response) {
  if (![400, 422].includes(response.status)) return false;
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 65536) return false;
      chunks.push(part.value);
    }
    let text = Buffer.concat(chunks).toString('utf8');
    try {
      const value: unknown = JSON.parse(text);
      if (value && typeof value === 'object' && 'error' in value) {
        const error = value.error;
        if (typeof error === 'string') text = error;
        else if (
          error &&
          typeof error === 'object' &&
          'message' in error &&
          typeof error.message === 'string'
        )
          text = error.message;
        else return false;
      }
    } catch {
      // Some compatible endpoints return a plain-text unknown-parameter error.
    }
    return (
      /\bprompt_cache_key\b/i.test(text) &&
      /unknown|unrecognized|unsupported|not supported|not permitted|not allowed|extra_forbidden|unexpected|不支持|未知参数/i.test(
        text,
      )
    );
  } catch {
    return false;
  } finally {
    // A tee's cancellation waits for its other reader; the SDK still owns the original response.
    reader.cancel().catch(() => undefined);
  }
}

export function cacheFetch(
  config: CacheConfig,
  upstream: typeof fetch = globalThis.fetch,
): typeof fetch {
  if (!['openai-completions', 'openai-responses'].includes(config.api)) return upstream;
  const endpoint = `${config.baseURL.replace(/\/+$/, '')}/${config.api === 'openai-responses' ? 'responses' : 'chat/completions'}`;
  let cacheKeySupported = true;
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url !== endpoint || method.toUpperCase() !== 'POST') return upstream(input, init);
    const request = new Request(input instanceof Request ? input.clone() : input, init);
    const payload: unknown = await request
      .clone()
      .json()
      .catch(() => undefined);
    if (
      !payload ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      !('model' in payload) ||
      payload.model !== config.model
    )
      return upstream(input, init);
    const body = payload as Record<string, unknown>;
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    headers.set('session_id', config.key);
    if (cacheKeySupported) body.prompt_cache_key = config.key;
    else delete body.prompt_cache_key;
    const send = () => upstream(new Request(request, { headers, body: JSON.stringify(body) }));
    const response = await send();
    if (!cacheKeySupported || !(await unsupportedCacheKey(response))) return response;
    cacheKeySupported = false;
    delete body.prompt_cache_key;
    await response.body?.cancel();
    return send();
  };
}

export function apply(
  ctx: { on: (event: 'dispose', callback: () => unknown) => unknown },
  config: CacheConfig,
) {
  const previous = globalThis.fetch;
  const wrapped = cacheFetch(config, previous);
  if (wrapped === previous) return;
  if (!/^daban-[a-f0-9]{48}$/.test(config.key)) throw new Error('INVALID_PROMPT_CACHE_ID');
  // DSH 0.2.1-rc.3 exposes no payload hook. Each task owns this child process; remove this
  // endpoint-scoped shim when its provider exposes fetch/onPayload configuration.
  globalThis.fetch = wrapped;
  ctx.on('dispose', () => {
    if (globalThis.fetch === wrapped) globalThis.fetch = previous;
  });
}
