import { type ModelApi, modelApi } from '@daban/protocol';

export interface InferenceModel {
  api?: ModelApi;
  baseURL: string;
  apiKey: string;
  apiModel: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function inferenceRequest(
  model: InferenceModel,
  input: { system?: string; prompt: string; maxTokens: number; json?: boolean },
): { url: string; init: RequestInit } {
  const api = modelApi(model);
  const base = model.baseURL.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  let url: string;
  let body: object;
  if (api === 'anthropic-messages') {
    headers['x-api-key'] = model.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    url = `${base}/v1/messages`;
    body = {
      model: model.apiModel,
      max_tokens: input.maxTokens,
      stream: false,
      ...(input.system ? { system: input.system } : {}),
      messages: [{ role: 'user', content: input.prompt }],
    };
  } else if (api === 'google-generative-ai') {
    headers['x-goog-api-key'] = model.apiKey;
    const name = model.apiModel.replace(/^models\//, '');
    url = `${base}/models/${encodeURIComponent(name)}:generateContent`;
    body = {
      ...(input.system ? { systemInstruction: { parts: [{ text: input.system }] } } : {}),
      contents: [{ role: 'user', parts: [{ text: input.prompt }] }],
      generationConfig: {
        maxOutputTokens: input.maxTokens,
        ...(input.json ? { responseMimeType: 'application/json' } : {}),
      },
    };
  } else if (api === 'openai-responses') {
    headers.authorization = `Bearer ${model.apiKey}`;
    url = `${base}/responses`;
    body = {
      model: model.apiModel,
      input: input.prompt,
      stream: false,
      ...(input.system ? { instructions: input.system } : {}),
      max_output_tokens: Math.max(16, input.maxTokens),
      ...(input.json ? { text: { format: { type: 'json_object' } } } : {}),
    };
  } else {
    headers.authorization = `Bearer ${model.apiKey}`;
    url = `${base}/chat/completions`;
    body = {
      model: model.apiModel,
      stream: false,
      max_tokens: input.maxTokens,
      ...(input.system ? { temperature: 0 } : {}),
      ...(new URL(base).hostname === 'api.deepseek.com' && input.json
        ? { thinking: { type: 'disabled' } }
        : {}),
      ...(input.json ? { response_format: { type: 'json_object' } } : {}),
      messages: [
        ...(input.system ? [{ role: 'system', content: input.system }] : []),
        { role: 'user', content: input.prompt },
      ],
    };
  }
  return { url, init: { method: 'POST', redirect: 'error', headers, body: JSON.stringify(body) } };
}

export function inferenceText(
  api: ModelApi | undefined,
  value: unknown,
  allowIncomplete = false,
): string | null {
  if (!object(value) || value.error != null) return null;
  if (api === 'anthropic-messages') {
    if (
      value.type !== 'message' ||
      value.role !== 'assistant' ||
      !['end_turn', 'stop_sequence', ...(allowIncomplete ? ['max_tokens'] : [])].includes(
        String(value.stop_reason),
      ) ||
      !Array.isArray(value.content)
    )
      return null;
    const parts: string[] = [];
    for (const part of value.content) {
      if (!object(part)) return null;
      if (part.type === 'text' && typeof part.text === 'string') parts.push(part.text);
      else if (!['thinking', 'redacted_thinking'].includes(String(part.type))) return null;
    }
    return parts.length || allowIncomplete ? parts.join('') : null;
  }
  if (api === 'google-generative-ai') {
    if (
      (object(value.promptFeedback) && value.promptFeedback.blockReason !== undefined) ||
      !Array.isArray(value.candidates) ||
      value.candidates.length !== 1
    )
      return null;
    const candidate: unknown = value.candidates[0];
    if (
      !object(candidate) ||
      !['STOP', ...(allowIncomplete ? ['MAX_TOKENS'] : [])].includes(
        String(candidate.finishReason),
      ) ||
      !object(candidate.content) ||
      !Array.isArray(candidate.content.parts) ||
      (Array.isArray(candidate.safetyRatings) &&
        candidate.safetyRatings.some((rating) => object(rating) && rating.blocked === true))
    )
      return null;
    const parts: string[] = [];
    for (const part of candidate.content.parts) {
      if (
        !object(part) ||
        typeof part.text !== 'string' ||
        Object.keys(part).some((key) => !['text', 'thought', 'thoughtSignature'].includes(key))
      )
        return null;
      if (part.thought !== true) parts.push(part.text);
    }
    return parts.length || allowIncomplete ? parts.join('') : null;
  }
  if (api === 'openai-responses') {
    if (
      !['completed', ...(allowIncomplete ? ['incomplete'] : [])].includes(String(value.status)) ||
      !Array.isArray(value.output)
    )
      return null;
    const parts: string[] = [];
    for (const item of value.output) {
      if (!object(item)) return null;
      if (item.type === 'reasoning') continue;
      if (
        item.type !== 'message' ||
        item.role !== 'assistant' ||
        (item.status !== undefined &&
          item.status !== 'completed' &&
          !(allowIncomplete && item.status === 'incomplete')) ||
        !Array.isArray(item.content)
      )
        return null;
      for (const part of item.content) {
        if (!object(part) || part.type !== 'output_text' || typeof part.text !== 'string')
          return null;
        parts.push(part.text);
      }
    }
    return parts.length || allowIncomplete ? parts.join('') : null;
  }
  if (!Array.isArray(value.choices) || value.choices.length !== 1) return null;
  const choice: unknown = value.choices[0];
  if (
    !object(choice) ||
    !['stop', ...(allowIncomplete ? ['length'] : [])].includes(String(choice.finish_reason)) ||
    !object(choice.message) ||
    (choice.message.role !== undefined && choice.message.role !== 'assistant') ||
    choice.message.refusal != null ||
    choice.message.function_call != null ||
    (choice.message.tool_calls !== undefined &&
      (!Array.isArray(choice.message.tool_calls) || choice.message.tool_calls.length !== 0))
  )
    return null;
  if (typeof choice.message.content === 'string') return choice.message.content;
  return allowIncomplete &&
    choice.message.content == null &&
    typeof choice.message.reasoning_content === 'string'
    ? ''
    : null;
}

/** Parse the provider wire, never a normalized SDK usage object with default zeros. */
export function inferenceUsage(
  api: ModelApi,
  value: unknown,
): import('@daban/protocol').TokenUsage {
  const unknown = { state: 'unknown', reason: 'PROVIDER_USAGE_MISSING_OR_INVALID' } as const;
  if (!object(value) || !object(value.usage)) return unknown;
  const usage = value.usage;
  let input: unknown;
  let output: unknown;
  let read: unknown;
  let write: unknown;
  if (api === 'openai-completions') {
    input = usage.prompt_tokens;
    output = usage.completion_tokens;
    if (object(usage.prompt_tokens_details)) {
      read = usage.prompt_tokens_details.cached_tokens;
      write = usage.prompt_tokens_details.cache_write_tokens;
    }
    if (
      usage.prompt_cache_hit_tokens !== undefined &&
      read !== undefined &&
      usage.prompt_cache_hit_tokens !== read
    )
      return unknown;
    read = usage.prompt_cache_hit_tokens ?? read;
    if (
      object(usage.completion_tokens_details) &&
      usage.completion_tokens_details.reasoning_tokens !== undefined &&
      (!Number.isSafeInteger(usage.completion_tokens_details.reasoning_tokens) ||
        Number(usage.completion_tokens_details.reasoning_tokens) < 0 ||
        Number(usage.completion_tokens_details.reasoning_tokens) > Number(output))
    )
      return unknown;
  } else if (api === 'openai-responses') {
    input = usage.input_tokens;
    output = usage.output_tokens;
    if (object(usage.input_tokens_details)) {
      read = usage.input_tokens_details.cached_tokens;
      write = usage.input_tokens_details.cache_write_tokens;
    }
  } else if (api === 'anthropic-messages') {
    input = usage.input_tokens;
    output = usage.output_tokens;
    read = usage.cache_read_input_tokens;
    write = usage.cache_creation_input_tokens;
  } else return unknown;
  if (![input, output, read, write].every((v) => Number.isSafeInteger(v) && Number(v) >= 0))
    return unknown;
  const inputTokens =
    Number(input) + (api === 'anthropic-messages' ? Number(read) + Number(write) : 0);
  if (
    !Number.isSafeInteger(inputTokens + Number(output)) ||
    Number(read) + Number(write) > inputTokens
  )
    return unknown;
  return {
    state: 'reported',
    inputTokens,
    outputTokens: Number(output),
    cacheReadTokens: Number(read),
    cacheWriteTokens: Number(write),
  };
}
