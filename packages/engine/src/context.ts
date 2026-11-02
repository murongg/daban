import { Fault } from './control.js';

export function contextBudget(contextWindow: number, outputTokens: number) {
  const available = contextWindow - outputTokens;
  if (
    !Number.isSafeInteger(contextWindow) ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 1 ||
    available < 1024
  )
    throw new Fault('MODEL_CONTEXT_BUDGET_INVALID', 400);
  const headroomTokens = Math.min(
    8192,
    Math.max(256, Math.floor(available / 10)),
    Math.floor(available / 4),
  );
  const thresholdTokens = Math.floor(Math.min(contextWindow * 0.8, available - headroomTokens));
  const retainTokens = Math.min(
    32768,
    Math.max(512, Math.floor(available / 8)),
    Math.floor(thresholdTokens / 2),
  );
  const maxTokens = Math.min(outputTokens, 8192, Math.max(512, Math.floor(available / 25)));
  return { thresholdRatio: 0.8, headroomTokens, retainTokens, maxTokens, thresholdTokens };
}

// This reserves room for recovery text only. DSH's token meter still owns live pressure and provider usage.
export function contextEstimate(text: string) {
  let ascii = 0,
    unicode = 0;
  for (const char of text) char.codePointAt(0)! < 128 ? ascii++ : unicode++;
  return Math.ceil(ascii / 3 + unicode * 2);
}

export function recoveryBudget(window: number, output: number, current: string, images = 0) {
  // Image pricing is provider-specific; reserve conservative space before adding recoverable history.
  const visualReserve = images * 8192;
  return Math.max(
    0,
    Math.min(
      65536,
      contextBudget(window, output).thresholdTokens -
        contextEstimate(current) -
        visualReserve -
        1024,
    ),
  );
}

export function contextPrefix(text: string, bytes: number) {
  let used = 0,
    end = 0;
  for (const char of text) {
    used += Buffer.byteLength(char);
    if (used > bytes) break;
    end += char.length;
  }
  return text.slice(0, end);
}
