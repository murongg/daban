/** Synthetic coverage fixture: force one SDK recovery at its public request-error hook. */
export const name = 'synthetic-budget-retry';
interface Context {
  on(
    event: 'agent/request-error',
    listener: (
      payload: { failure: { code: string } },
      next: () => Promise<unknown>,
    ) => Promise<unknown>,
  ): unknown;
}
export function apply(ctx: Context) {
  let retried = false;
  ctx.on('agent/request-error', async (payload, next) => {
    if (!retried && payload.failure.code === 'RATE_LIMIT') {
      retried = true;
      return { kind: 'retry' };
    }
    return next();
  });
}
