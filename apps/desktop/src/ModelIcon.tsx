import { Cpu } from 'lucide-react';
import { t, useLocale } from './locale';
import { ProviderIcon } from './ProviderIcon';
import { platforms } from './platforms';
import { Tooltip } from './Tooltip';

const families: [RegExp, string][] = [
  [/^(?:gpt(?:[-_.]|$)|chatgpt(?:[-_.]|$)|o[134](?:[-_.]|$))/, 'openai'],
  [/^claude(?:[-_.]|$)/, 'claude'],
  [/^gemini(?:[-_.]|$)/, 'gemini'],
  [/^deepseek(?:[-_.]|$)/, 'deepseek'],
  [/^(?:qwen|qwq)(?:\d|[-_.]|$)/, 'qwen'],
  [/^(?:kimi|moonshot)(?:[-_.]|$)/, 'kimi'],
  [/^(?:glm|chatglm)(?:\d|[-_.]|$)/, 'zhipu'],
  [/^(?:minimax|abab)(?:\d|[-_.]|$)/, 'minimax'],
  [/^grok(?:[-_.]|$)/, 'xai'],
  [/^(?:doubao|seed)(?:[-_.]|$)/, 'ark'],
  [/^hunyuan(?:[-_.]|$)/, 'hunyuan'],
  [/^ernie(?:[-_.]|$)/, 'qianfan'],
];
export function ModelIcon({ id, fallback = 'custom' }: { id?: string; fallback?: string }) {
  useLocale();
  const family = id?.toLowerCase().split('/').at(-1) ?? '';
  // Model marks describe the family; supplier marks still come only from the configured API destination.
  const identity = families.find(([pattern]) => pattern.test(family))?.[1] ?? fallback;
  const platform = platforms.find((entry) => entry.id === identity && identity !== 'custom');
  return (
    <Tooltip
      label={
        platform ? t('models.familyIcon', { 0: t(platform.name) }) : t('models.customModelIcon')
      }
    >
      <span className="model-brand" data-model-brand={identity} aria-hidden="true">
        {platform ? (
          <ProviderIcon platform={identity} />
        ) : (
          <span className="provider-icon">
            <Cpu />
          </span>
        )}
      </span>
    </Tooltip>
  );
}
