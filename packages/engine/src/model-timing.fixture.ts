import type { SearchSettings } from './search-settings.js';

export async function modelPhase<T>(stage: string, operation: () => T): Promise<Awaited<T>> {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    if (process.platform === 'win32')
      console.info('[model-phase]', stage, Math.round(performance.now() - started));
  }
}

export function observeSearch(settings: Pick<SearchSettings, 'capture'>) {
  const capture = settings.capture.bind(settings);
  settings.capture = () => modelPhase('search.capture', capture);
}
