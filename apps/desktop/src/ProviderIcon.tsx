import { Plug } from 'lucide-react';
import { platforms } from './platforms';
import './provider-icon.css';

const monochrome = new Set(['openai', 'xai', 'openrouter', 'groq']);

export function ProviderIcon({
  platform = 'custom',
  size = 'small',
}: {
  platform?: string;
  size?: 'small' | 'large';
}) {
  const known = platform !== 'custom' && platforms.some((entry) => entry.id === platform);
  const identity = known ? platform : 'custom';
  return (
    <span
      className={`provider-icon provider-icon-${size}${monochrome.has(identity) ? ' provider-icon-monochrome' : ''}${identity === 'kimi' ? ' provider-icon-adaptive' : ''}`}
      data-provider={identity}
      aria-hidden="true"
    >
      {known ? (
        <>
          <img
            className="provider-icon-light"
            src={`${import.meta.env.BASE_URL}providers/${identity}.svg`}
            alt=""
          />
          {identity === 'kimi' && (
            <img
              className="provider-icon-dark"
              src={`${import.meta.env.BASE_URL}providers/kimi-dark.svg`}
              alt=""
            />
          )}
        </>
      ) : (
        <Plug />
      )}
    </span>
  );
}
