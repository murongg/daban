import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { type DiagnosticCheck, type DiagnosticReport, diagnosticIds } from '@daban/protocol';

type Result = Omit<DiagnosticCheck, 'id'>;
export type DiagnosticSources = Record<
  (typeof diagnosticIds.runtime)[number],
  () => Result | Promise<Result>
>;
export async function desktopDependencies(): Promise<Result> {
  if (process.platform !== 'linux') return { state: 'unsupported' };
  const directories = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  // Presence only: importing the browser here would bypass its input patch and break later connections.
  for (const command of [
    'bwrap',
    'Xvfb',
    'xauth',
    'xdpyinfo',
    'dbus-run-session',
    'xsetroot',
    'tint2',
    'openbox',
    'wmctrl',
    'python3',
    'xdotool',
    'xclip',
    'xprop',
    'xterm',
    'thunar',
    'mousepad',
  ]) {
    const found = await Promise.all(
      directories.map((directory) =>
        access(path.join(directory, command), constants.X_OK).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (!found.some(Boolean)) return { state: 'unavailable' };
  }
  return { state: 'ready' };
}
export class Diagnostics {
  private pending?: { values: Map<string, Result>; done: Promise<unknown> };
  constructor(
    private readonly sources: DiagnosticSources,
    private readonly timeout = 1500,
  ) {}
  private start() {
    const current = {
      values: new Map<string, Result>(),
      done: Promise.resolve<unknown>(undefined),
    };
    this.pending = current;
    current.done = Promise.all(
      diagnosticIds.runtime.map(async (id) => {
        try {
          const result = await this.sources[id]();
          current.values.set(id, {
            state: result.state,
            ...(result.affected === undefined ? {} : { affected: result.affected }),
          });
        } catch {
          current.values.set(id, { state: 'unavailable' });
        }
      }),
    ).then(() => {
      if (this.pending === current) this.pending = undefined;
    });
    return current;
  }
  async inspect(): Promise<DiagnosticReport> {
    const current = this.pending ?? this.start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A response deadline does not retire a live probe or let later polls spawn another one.
      await Promise.race([
        current.done,
        new Promise((resolve) => {
          timer = setTimeout(resolve, this.timeout);
        }),
      ]);
      return {
        scope: 'runtime',
        checkedAt: new Date().toISOString(),
        checks: diagnosticIds.runtime.map((id) => ({
          id,
          ...(current.values.get(id) ?? { state: 'timeout' }),
        })),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
