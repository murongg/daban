import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { BrowserContext, BrowserType } from 'playwright';
import { Fault } from './control.js';
import { privateMetadata, secureDirectory } from './private-files.js';

export interface DesktopBrowser {
  context: BrowserContext;
  control(
    bot: string,
    instance: string,
    epoch: number,
    owner: 'human' | 'agent' | 'handoff',
  ): Promise<unknown>;
  close(): Promise<unknown>;
}
export async function connectDesktop(
  file: string,
  proxy: string,
  engine: Pick<BrowserType, 'connectOverCDP'>,
): Promise<DesktopBrowser | undefined> {
  const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!info) return;
  try {
    await secureDirectory(path.dirname(file));
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > 512 ||
      !(await privateMetadata(file, info, 0o600))
    )
      throw new Error('UNSAFE_BRIDGE');
    const descriptor: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor))
      throw new Error('INVALID_BRIDGE');
    const data = descriptor as Record<string, unknown>;
    if (
      Object.keys(data).length !== 2 ||
      typeof data.origin !== 'string' ||
      !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(data.origin) ||
      typeof data.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.token)
    )
      throw new Error('INVALID_BRIDGE');
    const origin = new URL(data.origin).origin;
    const headers = { authorization: `Bearer ${data.token}` };
    const post = async (route: string, body: Record<string, unknown>) => {
      const response = await fetch(`${origin}${route}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!response.ok) throw new Fault('HOST_BROWSER_DESKTOP_UNAVAILABLE', 503);
      await response.arrayBuffer();
    };
    await post('/configure', { proxy });
    const browser = await engine.connectOverCDP(`${origin.replace('http:', 'ws:')}/cdp`, {
      headers,
      timeout: 15000,
      isLocal: true,
      artifactsDir: path.join(path.dirname(file), 'browser/profile/.downloads'),
    });
    const contexts = browser.contexts();
    if (contexts.length !== 1) {
      await browser.close();
      throw new Error('INVALID_BRIDGE');
    }
    return {
      context: contexts[0],
      control: (bot, instance, epoch, owner) => post('/control', { bot, instance, epoch, owner }),
      close: async () => {
        await browser.close();
      },
    };
  } catch {
    throw new Fault('HOST_BROWSER_DESKTOP_UNAVAILABLE', 503);
  }
}
