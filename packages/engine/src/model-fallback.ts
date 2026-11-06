import type { ModelFailure } from './model-failure.js';
import type { ResolvedModel } from './settings.js';
export function fallbackIssue(
  model: Pick<ResolvedModel, 'vision' | 'contextWindow' | 'maxTokens' | 'capabilities'>,
  input: { vision: boolean; tools: boolean; contextTokens: number },
): string | undefined {
  if (input.vision && !model.vision) return 'MODEL_FALLBACK_VISION_REQUIRED';
  if (input.contextTokens + model.maxTokens + 1024 >= model.contextWindow)
    return 'MODEL_FALLBACK_CONTEXT_REQUIRED';
  if (input.tools && model.capabilities?.toolCall !== true)
    return model.capabilities?.toolCall === false
      ? 'MODEL_FALLBACK_TOOLS_REQUIRED'
      : 'MODEL_FALLBACK_TOOLS_UNKNOWN';
  return undefined;
}
export type AttemptFence = 'clean' | 'output' | 'tool' | 'unknown';
export interface FallbackInput {
  enabled: boolean;
  attempts: number;
  fence: AttemptFence;
  failure: ModelFailure;
  stopped: boolean;
  closed: boolean;
  inserted: boolean;
  eligible: boolean;
  budgetAvailable: boolean;
}
export function canFallback(input: FallbackInput) {
  return (
    input.enabled &&
    input.attempts === 1 &&
    input.fence === 'clean' &&
    input.failure !== 'unknown' &&
    !input.stopped &&
    input.closed &&
    !input.inserted &&
    input.eligible &&
    input.budgetAvailable
  );
}
