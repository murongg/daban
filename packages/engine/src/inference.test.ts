import assert from 'node:assert/strict';
import test from 'node:test';
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
  assert.equal(anthropic.url, 'https://model.example.test/v1/messages');
  assert.equal(new Headers(anthropic.init.headers).get('x-api-key'), base.apiKey);
  assert.equal(new Headers(anthropic.init.headers).get('authorization'), null);
  const a = JSON.parse(String(anthropic.init.body));
  assert.equal(a.system, input.system);
  assert.equal(a.max_tokens, 128);
  assert.equal(a.response_format, undefined);
  const google = inferenceRequest(
    {
      ...base,
      baseURL: `${base.baseURL}/v1beta`,
      api: 'google-generative-ai',
      apiModel: 'models/mock-model',
    },
    input,
  );
  assert.equal(google.url, 'https://model.example.test/v1beta/models/mock-model:generateContent');
  assert.equal(new Headers(google.init.headers).get('x-goog-api-key'), base.apiKey);
  assert.equal(new Headers(google.init.headers).get('authorization'), null);
  assert.equal(google.url.includes(base.apiKey), false);
  const g = JSON.parse(String(google.init.body));
  assert.equal(g.generationConfig.responseMimeType, 'application/json');
  assert.equal(g.generationConfig.maxOutputTokens, 128);
  assert.deepEqual(g.systemInstruction, { parts: [{ text: input.system }] });
  const responses = inferenceRequest(
    { ...base, baseURL: `${base.baseURL}/v1`, api: 'openai-responses' },
    input,
  );
  assert.equal(responses.url, 'https://model.example.test/v1/responses');
  const r = JSON.parse(String(responses.init.body));
  assert.equal(r.max_output_tokens, 128);
  assert.equal(r.instructions, input.system);
  assert.equal(r.input, input.prompt);
  assert.equal(r.messages, undefined);
  for (const request of [anthropic, google, responses]) {
    assert.equal(request.init.redirect, 'error');
    assert.equal(
      JSON.stringify(JSON.parse(String(request.init.body))).includes(base.apiKey),
      false,
    );
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
  assert.equal(inferenceText('anthropic-messages', claude), text);
  assert.equal(inferenceText('google-generative-ai', google), text);
  assert.equal(inferenceText('openai-responses', responses), text);
  assert.equal(inferenceText('anthropic-messages', { ...claude, stop_reason: 'max_tokens' }), null);
  assert.equal(
    inferenceText('google-generative-ai', {
      candidates: [{ ...google.candidates[0], finishReason: 'MAX_TOKENS' }],
    }),
    null,
  );
  assert.equal(inferenceText('openai-responses', { ...responses, status: 'incomplete' }), null);
  assert.equal(
    inferenceText('anthropic-messages', {
      ...claude,
      content: [...claude.content, { type: 'tool_use', id: 'mock' }],
    }),
    null,
  );
  assert.equal(
    inferenceText('google-generative-ai', {
      candidates: [{ ...google.candidates[0], content: { parts: [{ text, thought: true }] } }],
    }),
    null,
  );
  assert.equal(
    inferenceText('google-generative-ai', { ...google, promptFeedback: { blockReason: 'SAFETY' } }),
    null,
  );
  assert.equal(
    inferenceText('openai-responses', {
      ...responses,
      output: [...responses.output, { type: 'function_call' }],
    }),
    null,
  );
});

test('native probe parsing permits explicitly truncated text but rejects malformed and nontext results', () => {
  assert.equal(
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
    'OK',
  );
  assert.equal(
    inferenceText(
      'google-generative-ai',
      { candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'OK' }] } }] },
      true,
    ),
    'OK',
  );
  for (const api of [
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
    'google-generative-ai',
  ] as const)
    for (const value of [null, {}, { error: { message: 'synthetic' } }])
      assert.equal(inferenceText(api, value, true), null);
});

test('unrequested tool or refusal envelopes cannot masquerade as a textual approval', () => {
  const message = { role: 'assistant', content: '{"risk":"low"}' };
  for (const extra of [
    { tool_calls: {} },
    { function_call: { name: 'mock' } },
    { refusal: 'Denied' },
  ])
    assert.equal(
      inferenceText('openai-completions', {
        choices: [{ finish_reason: 'stop', message: { ...message, ...extra } }],
      }),
      null,
    );
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
  assert.equal(inferenceText('openai-responses', reply), '{"risk":"low"}');
  assert.equal(
    inferenceText('openai-responses', { ...reply, error: { code: 'mock-error' } }),
    null,
  );
});
