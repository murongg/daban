import {
  type BotDefinition,
  type BotRelease,
  type InstallationState,
  parseBotRelease,
} from '@daban/protocol';
import { useEffect, useRef, useState } from 'react';
import { runtimeError } from '../../app/Runtime';

export interface Source {
  origin: string;
  sourceId: string;
  name: string;
  authenticated: boolean;
}
export interface TemplateView {
  installation: InstallationState | null;
  definition: BotDefinition | null;
  history: { revision: number; version: string }[];
  draft: { revision: number; content?: string } | null;
}
export type Prepared = { release: BotRelease; digest: string; revision?: number; origin?: string };
export const pendingKey = 'daban.templates.pending';
export async function readRelease(file: File) {
  if (file.size > 104857600) throw Error('PACKAGE_TOO_LARGE');
  return parseBotRelease(
    new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()),
  );
}
export function useTemplateWork() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const live = useRef(true);
  const running = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const run = async (work: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setMessage('');
    try {
      await work();
    } catch (error) {
      if (live.current) setMessage(runtimeError(error));
    } finally {
      running.current = false;
      if (live.current) setBusy(false);
    }
  };
  return { busy, message, setMessage, run };
}
