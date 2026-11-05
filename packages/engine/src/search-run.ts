import { createHash } from 'node:crypto';
import type { SearchResult } from '@daban/protocol';
import { Fault } from './control.js';
import type { SearchCapture, SearchSettings } from './search-settings.js';

export interface SearchRun {
  id: string;
  sessionId?: string;
  abort: AbortController;
  toolCount: number;
  limit: number;
  onLimit?: () => unknown;
  countedCalls?: Set<string>;
}
interface Query {
  runId: string;
  sessionId: string;
  executionSessionId: string;
  callId: string;
  searchRevision: number;
  queries: string[];
  query: string;
  maxResults: number;
}
interface Batch {
  fingerprint: string;
  queries: Map<string, Promise<SearchResult>>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{Cc}]/u.test(value);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const queryText = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  value.length <= 1200 &&
  Array.from(value).length <= 600;
function parse(value: unknown): Query {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'runId',
          'sessionId',
          'executionSessionId',
          'callId',
          'searchRevision',
          'queries',
          'query',
          'maxResults',
        ].includes(key),
    ) ||
    !text(value.runId, 100) ||
    !text(value.sessionId, 1000) ||
    !text(value.executionSessionId, 1000) ||
    !text(value.callId, 200) ||
    !Number.isSafeInteger(value.searchRevision) ||
    Number(value.searchRevision) < 0 ||
    !Array.isArray(value.queries) ||
    value.queries.length < 1 ||
    value.queries.length > 4 ||
    !value.queries.every(queryText) ||
    !queryText(value.query) ||
    !value.queries.includes(value.query) ||
    !Number.isSafeInteger(value.maxResults) ||
    Number(value.maxResults) < 1 ||
    Number(value.maxResults) > 5
  )
    throw new Fault('SEARCH_INVALID_QUERY', 400);
  return {
    runId: value.runId,
    sessionId: value.sessionId,
    executionSessionId: value.executionSessionId,
    callId: value.callId,
    searchRevision: Number(value.searchRevision),
    queries: [...new Set(value.queries)],
    query: value.query,
    maxResults: Number(value.maxResults),
  };
}
export class RunSearch {
  private readonly requests = new Map<
    string,
    { fingerprint: string; result: Promise<SearchResult> }
  >();
  private readonly batches = new Map<string, Batch>();
  constructor(
    private readonly settings: Pick<SearchSettings, 'query' | 'capture'>,
    private readonly snapshot: SearchCapture,
    private readonly run: SearchRun,
    private readonly effect?: (
      claimId: string,
      query: string,
      dispatch: (beforeSend?: () => unknown) => Promise<SearchResult>,
    ) => Promise<SearchResult>,
  ) {}
  private owner(query: Query) {
    if (this.run.abort.signal.aborted) throw new Fault('SEARCH_CANCELLED');
    if (this.run.toolCount > this.run.limit) this.limit();
    if (query.runId !== this.run.id || query.sessionId !== this.run.sessionId)
      throw new Fault('UNAUTHORIZED', 403);
    if (query.searchRevision !== this.snapshot.revision) throw new Fault('SEARCH_CONFIG_CHANGED');
    if (!this.snapshot.available) throw new Fault('SEARCH_NOT_CONFIGURED');
  }
  private async current(query: Query) {
    this.owner(query);
    const current = await this.settings.capture();
    this.owner(query);
    if (
      !current.available ||
      current.binding !== this.snapshot.binding ||
      current.revision !== this.snapshot.revision ||
      current.provider !== this.snapshot.provider
    )
      throw new Fault('SEARCH_CONFIG_CHANGED');
  }
  private limit() {
    this.run.onLimit?.();
    throw new Fault('TOOL_LIMIT');
  }
  async query(rpcId: unknown, params: unknown): Promise<SearchResult> {
    if (!(text(rpcId, 200) || (typeof rpcId === 'number' && Number.isSafeInteger(rpcId))))
      throw new Fault('SEARCH_INVALID_QUERY', 400);
    const query = parse(params);
    this.owner(query);
    const identity = JSON.stringify([typeof rpcId, rpcId]);
    const fingerprint = digest(query);
    const previous = this.requests.get(identity);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Fault('SEARCH_REQUEST_CONFLICT');
      return this.result(previous.result, query);
    }
    if (
      !Number.isSafeInteger(this.run.limit) ||
      this.run.limit < 1 ||
      this.requests.size >= this.run.limit * 4
    )
      this.limit();
    const batchKey = JSON.stringify([query.executionSessionId, query.callId]);
    const batchFingerprint = digest([query.queries, query.maxResults]);
    let batch = this.batches.get(batchKey);
    if (batch && batch.fingerprint !== batchFingerprint) throw new Fault('SEARCH_REQUEST_CONFLICT');
    if (!batch) {
      if (this.batches.size >= this.run.limit) this.limit();
      this.run.countedCalls ??= new Set();
      const counted = this.run.countedCalls;
      // Native progress and private RPC can arrive in either order; they spend this one shared tool slot.
      if (!counted.has(batchKey)) {
        counted.add(batchKey);
        this.run.toolCount++;
      }
      if (this.run.toolCount > this.run.limit) this.limit();
      batch = { fingerprint: batchFingerprint, queries: new Map() };
      this.batches.set(batchKey, batch);
    }
    if (this.run.toolCount > this.run.limit) this.limit();
    let result = batch.queries.get(query.query);
    if (!result) {
      result = this.dispatch(query);
      // Retain rejected outcomes too: another RPC identity must not replay an uncertain paid request.
      batch.queries.set(query.query, result);
    }
    this.requests.set(identity, { fingerprint, result });
    return this.result(result, query);
  }
  private async dispatch(query: Query) {
    await this.current(query);
    const dispatch = (beforeSend?: () => unknown) =>
      this.settings.query(
        this.snapshot,
        query.query,
        this.run.abort.signal,
        query.maxResults,
        beforeSend,
      );
    const result = await (this.effect
      ? this.effect(query.callId, query.query, dispatch)
      : dispatch());
    await this.current(query);
    return structuredClone(result);
  }
  private async result(result: Promise<SearchResult>, query: Query) {
    const value = await result;
    // Even a cached success loses source authority after Stop, session replacement or a config edit.
    await this.current(query);
    return structuredClone(value);
  }
}
