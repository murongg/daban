import type { GallerySession } from '@daban/protocol';
import type { Translate } from './Messages';

export type Api = <T = unknown>(route: string, init?: RequestInit) => Promise<T>;
export type Run = (work: () => Promise<unknown>) => Promise<boolean>;
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
export function createClient(
  fetcher: typeof fetch,
  session: () => GallerySession | undefined,
  expired: () => unknown,
  messages: () => Translate,
): Api {
  return async <T>(route: string, init: RequestInit = {}) => {
    const current = session();
    const response = await fetcher(`/api/v1${route}`, {
      ...init,
      credentials: 'same-origin',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(current ? { 'X-CSRF-Token': current.csrfToken } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      // A late response from an old credential must not clear a newly established session.
      if (response.status === 401 && current && current === session()) expired();
      throw new ApiError(
        messages()(response.status === 401 ? 'gallery.required' : 'gallery.failed'),
        response.status,
      );
    }
    return response.status === 204 ? (null as T) : ((await response.json()) as T);
  };
}
