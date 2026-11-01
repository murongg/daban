import {
  type BotCopyRequest,
  botCopyKey,
  type GroupCopyRequest,
  groupCopyKey,
  isBotCopyReceipt,
  isBotCopyRequest,
  isGroupCopyReceipt,
  isGroupCopyRequest,
  recoveryBlocked,
} from '@daban/protocol';
import { type Dispatch, useCallback, useEffect, useRef, useState } from 'react';
import { clientCache } from './cache';
import { t } from './locale';
import { runtimeError, useRuntime } from './Runtime';
import { type Action, reduce, type State } from './state';
import { serialize, storageKey } from './storage';

type CopyRequest = BotCopyRequest | GroupCopyRequest;
export interface CopyProps {
  state: State;
  dispatch: Dispatch<Action>;
  open: boolean;
  close: () => unknown;
  notify: (message: string) => unknown;
}
// Reserve the suffix within the name limit without splitting an emoji's surrogate pair.
export const copyName = (name: string) =>
  t('copies.copy', { 0: name.slice(0, 27).replace(/[\uD800-\uDBFF]$/, '') });
const keyOf = (request: CopyRequest) =>
  'bot' in request ? botCopyKey(request) : groupCopyKey(request);
const hold = (request: CopyRequest): Action =>
  'bot' in request
    ? { type: 'bot-copy-pending', request }
    : { type: 'group-copy-pending', request };
const release = (request: CopyRequest): Action =>
  'bot' in request ? { type: 'bot-copy-clear', request } : { type: 'group-copy-clear', request };
function receipt(value: unknown, request: CopyRequest) {
  if ('bot' in request) {
    if (!isBotCopyReceipt(value) || botCopyKey(value.request) !== botCopyKey(request))
      throw new Error('INVALID_BOT_COPY_ACK');
    return value;
  }
  if (!isGroupCopyReceipt(value) || groupCopyKey(value.request) !== groupCopyKey(request))
    throw new Error('INVALID_GROUP_COPY_ACK');
  return value;
}
const sourceRejected = new Set([
  'BOT_PROFILE_CONFLICT',
  'BOT_ARCHIVED',
  'GROUP_CONFLICT',
  'GROUP_ARCHIVED',
]);
const attemptRejected = new Set([
  'INVALID_COMMAND',
  'INVALID_BOT_COPY',
  'INVALID_GROUP_COPY',
  'RUNTIME_TOO_OLD',
  'BOT_PROFILE_NOT_FOUND',
  'GROUP_NOT_FOUND',
]);

export function useCopy(
  kind: 'bot' | 'group',
  { state, dispatch, open, close, notify }: CopyProps,
) {
  const runtime = useRuntime();
  const stored = kind === 'bot' ? state.botCopy : state.groupCopy;
  const pending = useRef<CopyRequest | undefined>(stored),
    opened = useRef(open),
    mounted = useRef(true);
  const mutation = useRef<string | undefined>(undefined),
    reader = useRef<string | undefined>(undefined);
  const [working, setWorking] = useState(false),
    [reading, setReading] = useState(false),
    [error, setError] = useState('');
  pending.current = stored;
  opened.current = open;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open && !stored) setError('');
  }, [open, stored]);
  const owns = useCallback(
    (request: CopyRequest) =>
      mounted.current && !!pending.current && keyOf(pending.current) === keyOf(request),
    [],
  );
  const handle = useCallback(
    (value: unknown, request: CopyRequest) => {
      if (!owns(request)) return;
      const accepted = receipt(value, request);
      if (accepted.state !== 'complete') return;
      // A read may finish before the original mutation response; retire synchronously and only once.
      pending.current = undefined;
      mutation.current = undefined;
      if (reader.current === keyOf(request)) {
        reader.current = undefined;
        setReading(false);
      }
      setWorking(false);
      setError('');
      if ('profile' in accepted) dispatch({ type: 'profiles', profiles: [accepted.profile] });
      else dispatch({ type: 'groups', groups: [accepted.group] });
      dispatch(release(request));
      const target = 'profile' in accepted ? accepted.profile : accepted.group;
      if (opened.current) {
        if (!target.archived) dispatch({ type: 'select', bot: target.id });
        close();
      }
      notify(t('copies.copied', { 0: target.name }));
    },
    [owns, dispatch, close, notify],
  );
  const available =
    runtime.enabled &&
    runtime.snapshot.phase === 'ready' &&
    runtime.snapshot.protocolVersion >= (kind === 'bot' ? 34 : 35);
  const blocked = recoveryBlocked(runtime.snapshot);
  const check = useCallback(async () => {
    const request = pending.current;
    if (!request || reader.current || !available) return;
    const key = keyOf(request);
    reader.current = key;
    setReading(true);
    try {
      const command =
        'bot' in request
          ? { type: 'bot.copy.receipt' as const, request }
          : { type: 'group.copy.receipt' as const, request };
      handle(await runtime.command(command), request);
    } catch (error) {
      if (owns(request)) setError(runtimeError(error));
    } finally {
      if (reader.current === key) {
        reader.current = undefined;
        if (mounted.current) setReading(false);
      }
    }
  }, [available, runtime.command, handle, owns]);
  useEffect(() => {
    if (!stored || !available) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function tick() {
      await check();
      if (live && pending.current)
        timer = setTimeout(() => {
          tick().catch(() => {
            if (live) setError(t('copies.copyResultCannotVerifiedRightNow'));
          });
        }, 1000);
    }
    tick().catch(() => {
      if (live) setError(t('copies.copyResultCannotVerifiedRightNow'));
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [stored, available, check]);
  async function submit(input: CopyRequest) {
    if (mutation.current || !available || blocked) return;
    if (kind === 'bot' ? !isBotCopyRequest(input) : !isGroupCopyRequest(input)) {
      setError(runtimeError(new Error(kind === 'bot' ? 'INVALID_BOT_COPY' : 'INVALID_GROUP_COPY')));
      return;
    }
    if (pending.current && keyOf(pending.current) !== keyOf(input)) return;
    const resuming = !!pending.current,
      request = { ...input },
      key = keyOf(request),
      action = hold(request);
    try {
      // Persist before the effect, and never create a placeholder that legacy registration could occupy.
      clientCache().setItem(storageKey, serialize(reduce(state, action)));
    } catch {
      setError(t('copies.copyRequestCouldNotSavedLocallyFree'));
      return;
    }
    pending.current = request;
    dispatch(action);
    mutation.current = key;
    setWorking(true);
    setError('');
    try {
      const command =
        'bot' in request
          ? { type: 'bot.copy' as const, request }
          : { type: 'group.copy' as const, request };
      const value = receipt(await runtime.command(command), request);
      if (value.state !== 'complete')
        throw new Error('bot' in request ? 'INVALID_BOT_COPY_ACK' : 'INVALID_GROUP_COPY_ACK');
      handle(value, request);
    } catch (error) {
      if (owns(request)) {
        setError(
          error instanceof Error && error.message === 'GROUP_CONFLICT'
            ? t('copies.originalGroupChangedNewNameRetainedReview')
            : runtimeError(error),
        );
        // Rejecting this retry before dispatch cannot disprove an earlier unconfirmed submission.
        if (
          error instanceof Error &&
          (sourceRejected.has(error.message) || (!resuming && attemptRejected.has(error.message)))
        ) {
          pending.current = undefined;
          dispatch(release(request));
        }
      }
    } finally {
      if (mutation.current === key) {
        mutation.current = undefined;
        if (mounted.current) setWorking(false);
      }
    }
  }
  return { available, blocked, working, reading, error, submit, check };
}
