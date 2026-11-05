import { expect, test } from 'vitest';
import { inferenceUsage as parse } from './inference.js';

test('wire usage preserves provider totals and counts cache and reasoning only once', () => {
  expect(
    parse('openai-completions', {
      usage: {
        prompt_tokens: 55,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 },
        completion_tokens_details: { reasoning_tokens: 8 },
      },
    }),
  ).toEqual({
    state: 'reported',
    inputTokens: 55,
    outputTokens: 20,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
  });
});

test.each([
  {},
  { usage: { prompt_tokens: 55 } },
  { usage: { prompt_tokens: -1, completion_tokens: 1 } },
  { usage: { prompt_tokens: 1.5, completion_tokens: 1 } },
  {
    usage: { prompt_tokens: 2, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 3 } },
  },
  { usage: { prompt_tokens: 1, completion_tokens: Number.MAX_SAFE_INTEGER + 1 } },
])('missing or invalid provider buckets remain unknown: %j', (value) => {
  expect(parse('openai-completions', value)).toMatchObject({ state: 'unknown' });
});

test('an explicitly reported zero is distinguishable from missing usage', () => {
  expect(
    parse('openai-completions', {
      usage: {
        prompt_tokens: 0,
        completion_tokens: 0,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      },
    }),
  ).toEqual({
    state: 'reported',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test('Anthropic disjoint inputs and Responses inclusive inputs share one contract', () => {
  expect(
    parse('anthropic-messages', {
      usage: {
        input_tokens: 40,
        output_tokens: 20,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    }),
  ).toEqual({
    state: 'reported',
    inputTokens: 55,
    outputTokens: 20,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
  });
  expect(
    parse('openai-responses', {
      usage: {
        input_tokens: 55,
        output_tokens: 20,
        input_tokens_details: { cached_tokens: 10, cache_write_tokens: 0 },
      },
    }),
  ).toEqual({
    state: 'reported',
    inputTokens: 55,
    outputTokens: 20,
    cacheReadTokens: 10,
    cacheWriteTokens: 0,
  });
});

test('unsupported routes never fabricate usage', () => {
  expect(parse('google-generative-ai', { usageMetadata: { promptTokenCount: 55 } })).toMatchObject({
    state: 'unknown',
  });
});

test('missing cache bucket provenance and conflicting cache counters remain unknown', () => {
  expect(
    parse('openai-completions', { usage: { prompt_tokens: 10, completion_tokens: 2 } }),
  ).toMatchObject({ state: 'unknown' });
  expect(
    parse('openai-completions', {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_cache_hit_tokens: 3,
        prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 0 },
      },
    }),
  ).toMatchObject({ state: 'unknown' });
  expect(
    parse('openai-completions', {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 3 },
      },
    }),
  ).toMatchObject({ state: 'unknown' });
});
