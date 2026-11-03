import { expect, test } from 'vitest';
import { inferenceRequest, inferenceText } from './inference.js';

const base = {
  baseURL: 'https://model.example.test',
  apiKey: 'synthetic-native-key',
  apiModel: 'mock-model',
};
test('native inference requests keep credentials in protocol-specific headers and use native payloads', () => {
  const input = {
    prompt: 'Synthetic prompt',
    system: 'Synthetic instruction',
    maxTokens: 128,
    json: true,
  };
  const anthropic = inferenceRequest({ ...base, api: 'anthropic-messages' }, input);
  expect(anthropic.url).toBe('https://model.example.test/v1/messages');
  expect(new Headers(anthropic.init.headers).get('x-api-key')).toBe(base.apiKey);
  expect(new Headers(anthropic.init.headers).get('authorization')).toBe(null);
  const a = JSON.parse(String(anthropic.init.body));
  expect(a.system).toBe(input.system);
  expect(a.max_tokens).toBe(128);
  expect(a.response_format).toBe(undefined);
  const google = inferenceRequest(
    {
      ...base,
      baseURL: `${base.baseURL}/v1beta`,
      api: 'google-generative-ai',
      apiModel: 'models/mock-model',
    },
    input,
  );
  expect(google.url).toBe('https://model.example.test/v1beta/models/mock-model:generateContent');
  expect(new Headers(google.init.headers).get('x-goog-api-key')).toBe(base.apiKey);
  expect(new Headers(google.init.headers).get('authorization')).toBe(null);
  expect(google.url.includes(base.apiKey)).toBe(false);
  const g = JSON.parse(String(google.init.body));
  expect(g.generationConfig.responseMimeType).toBe('application/json');
  expect(g.generationConfig.maxOutputTokens).toBe(128);
  expect(g.systemInstruction).toStrictEqual({ parts: [{ text: input.system }] });
  const responses = inferenceRequest(
    { ...base, baseURL: `${base.baseURL}/v1`, api: 'openai-responses' },
    input,
  );
  expect(responses.url).toBe('https://model.example.test/v1/responses');
  const r = JSON.parse(String(responses.init.body));
  expect(r.max_output_tokens).toBe(128);
  expect(r.instructions).toBe(input.system);
  expect(r.input).toBe(input.prompt);
  expect(r.messages).toBe(undefined);
  for (const request of [anthropic, google, responses]) {
    expect(request.init.redirect).toBe('error');
    expect(JSON.stringify(JSON.parse(String(request.init.body))).includes(base.apiKey)).toBe(false);
  }
});

test('native result parsing accepts only complete textual model replies for approval decisions', () => {
  const text = '{"risk":"low"}';
  const claude = {
    type: 'message',
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text }],
  };
  const google = {
    candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } }],
  };
  const responses = {
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    ],
  };
  expect(inferenceText('anthropic-messages', claude)).toBe(text);
  expect(inferenceText('google-generative-ai', google)).toBe(text);
  expect(inferenceText('openai-responses', responses)).toBe(text);
  expect(inferenceText('anthropic-messages', { ...claude, stop_reason: 'max_tokens' })).toBe(null);
  expect(
    inferenceText('google-generative-ai', {
      candidates: [{ ...google.candidates[0], finishReason: 'MAX_TOKENS' }],
    }),
  ).toBe(null);
  expect(inferenceText('openai-responses', { ...responses, status: 'incomplete' })).toBe(null);
  expect(
    inferenceText('anthropic-messages', {
      ...claude,
      content: [...claude.content, { type: 'tool_use', id: 'mock' }],
    }),
  ).toBe(null);
  expect(
    inferenceText('google-generative-ai', {
      candidates: [{ ...google.candidates[0], content: { parts: [{ text, thought: true }] } }],
    }),
  ).toBe(null);
  expect(
    inferenceText('google-generative-ai', { ...google, promptFeedback: { blockReason: 'SAFETY' } }),
  ).toBe(null);
  expect(
    inferenceText('openai-responses', {
      ...responses,
      output: [...responses.output, { type: 'function_call' }],
    }),
  ).toBe(null);
});

test('native probe parsing permits explicitly truncated text but rejects malformed and nontext results', () => {
  expect(
    inferenceText(
      'anthropic-messages',
      {
        type: 'message',
        role: 'assistant',
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'OK' }],
      },
      true,
    ),
  ).toBe('OK');
  expect(
    inferenceText(
      'google-generative-ai',
      { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'OK' }] } }] },
      true,
    ),
  ).toBe('OK');
  for (const api of [
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
    'google-generative-ai',
  ] as const)
    for (const value of [null, {}, { error: { message: 'synthetic' } }])
      expect(inferenceText(api, value, true)).toBe(null);
});

test('unrequested tool or refusal envelopes cannot masquerade as a textual approval', () => {
  const message = { role: 'assistant', content: '{"risk":"low"}' };
  for (const extra of [
    { tool_calls: {} },
    { function_call: { name: 'mock' } },
    { refusal: 'Denied' },
  ])
    expect(
      inferenceText('openai-completions', {
        choices: [{ finish_reason: 'stop', message: { ...message, ...extra } }],
      }),
    ).toBe(null);
});

test('a completed Responses envelope may contain a null error field but never a real error', () => {
  const reply = {
    status: 'completed',
    error: null,
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '{"risk":"low"}' }],
      },
    ],
  };
  expect(inferenceText('openai-responses', reply)).toBe('{"risk":"low"}');
  expect(inferenceText('openai-responses', { ...reply, error: { code: 'mock-error' } })).toBe(null);
});
