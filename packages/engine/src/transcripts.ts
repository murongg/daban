import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Interaction,
  isTaskPlan,
  isTranscriptItem,
  isTranscriptScope,
  type TranscriptContent,
  type TranscriptItem,
  type TranscriptPage,
  type TranscriptScope,
  transcriptChunkLimit,
  transcriptEventLimit,
  transcriptPageLimit,
} from '@daban/protocol';
import { and, asc, eq, gt, max, sql } from 'drizzle-orm';
import { errorCode, Fault } from './control.js';
import { configure, type Database, migrate } from './database.js';
import { secureDirectory } from './private-files.js';
import { migrations } from './transcripts-migrations.js';
import { transcriptEvents, transcriptRuns } from './transcripts-schema.js';

export interface TranscriptEvent extends Omit<TranscriptItem, 'seq' | 'characters'> {
  source: string;
  text: string;
}

function transcriptText(text: string, redact: (value: string) => string) {
  try {
    JSON.parse(text);
    // Decode string tokens for redaction, while retaining numeric lexemes that JSON.parse/stringify would round.
    return redact(
      text.replace(/"(?:\\[\s\S]|[^"\\])*"/g, (token) =>
        JSON.stringify(redact(JSON.parse(token) as string)),
      ),
    );
  } catch {
    return redact(text);
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const short = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 300 && !value.includes('\0');
const publicCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,80}$/.test(value);

function legacy(client: DatabaseSync) {
  client.exec(`CREATE TABLE IF NOT EXISTS transcript_runs(run TEXT PRIMARY KEY,scope TEXT NOT NULL,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS transcript_events(run TEXT NOT NULL,seq INTEGER NOT NULL,source TEXT NOT NULL,meta TEXT NOT NULL,body TEXT NOT NULL,
      PRIMARY KEY(run,seq),UNIQUE(run,source));`);
}

function identity(scope: TranscriptScope) {
  if (!isTranscriptScope(scope)) throw new Fault('INVALID_TRANSCRIPT_SCOPE', 400);
  return JSON.stringify([
    scope.bot,
    scope.runId,
    scope.conversationId ?? null,
    scope.chatRevision ?? null,
  ]);
}

function metadata(seq: number, encoded: string): TranscriptItem {
  const value: unknown = JSON.parse(encoded);
  if (!record(value) || 'seq' in value) throw new Fault('TRANSCRIPT_CORRUPT');
  const item = { ...value, seq };
  if (!isTranscriptItem(item)) throw new Fault('TRANSCRIPT_CORRUPT');
  return item;
}

export function projectInteraction(
  item: Interaction,
  redact: (value: string) => string,
): TranscriptEvent {
  const body =
    item.kind === 'question'
      ? { questions: item.questions }
      : item.tool === 'web_fetch'
        ? { tool: item.tool, url: item.url }
        : item.tool === 'software_install'
          ? { tool: item.tool, plan: item.plan, purpose: item.purpose }
          : item.tool === 'vm_command'
            ? {
                tool: item.tool,
                command: item.command,
                cwd: item.cwd,
                purpose: item.purpose,
                target: item.target,
              }
            : {
                tool: item.tool,
                name: item.name,
                origin: item.origin,
                operation: item.operation,
                arguments: transcriptText(item.arguments, redact),
              };
  return {
    source: `human:${item.id}:${item.status}:${item.updatedAt}`,
    kind: 'interaction',
    at: item.updatedAt,
    name: item.kind,
    callId: redact(item.id),
    text: redact(
      JSON.stringify(
        {
          kind: item.kind,
          status: item.status,
          ...body,
          ...(item.reply ? { reply: item.reply } : {}),
          ...(item.decisionSource ? { decisionSource: item.decisionSource } : {}),
          ...(item.policyDecision ? { policyDecision: item.policyDecision } : {}),
        },
        (_key, value: unknown) => (typeof value === 'string' ? redact(value) : value),
        2,
      ),
    ),
  };
}

function visibleContent(value: unknown, redact: (value: string) => string) {
  if (!Array.isArray(value)) throw new Fault('INVALID_TRANSCRIPT_EVENT');
  return value
    .map((block) => {
      if (!record(block)) throw new Fault('INVALID_TRANSCRIPT_EVENT');
      if (block.type === 'text' && typeof block.text === 'string')
        return transcriptText(block.text, redact);
      // Binary results already belong to their tool/artifact owner; a transcript never duplicates their bytes.
      return `[未保存的非文本输出：${typeof block.mimeType === 'string' ? block.mimeType.slice(0, 100) : String(block.type).slice(0, 80)}]`;
    })
    .join('\n');
}

function nativeEvent(note: unknown, session: string) {
  if (
    !record(note) ||
    note.method !== 'session.event' ||
    !record(note.params) ||
    note.params.sessionId !== session ||
    !record(note.params.event)
  )
    return;
  const event = note.params.event;
  if (!['tool/call', 'tool/result', 'assistant/message', 'todo/write'].includes(String(event.type)))
    return;
  if (
    !integer(event.seq) ||
    !record(event.data) ||
    typeof event.time !== 'number' ||
    !Number.isFinite(new Date(event.time).valueOf())
  )
    throw new Fault('INVALID_TRANSCRIPT_EVENT');
  return { type: event.type, seq: event.seq, time: event.time, data: event.data };
}

export function projectThinking(
  note: unknown,
  session: string,
  redact: (value: string) => string,
): TranscriptEvent | undefined {
  const event = nativeEvent(note, session);
  if (event?.type !== 'assistant/message') return;
  const { data } = event;
  if (!record(data.message) || !Array.isArray(data.message.content))
    throw new Fault('INVALID_TRANSCRIPT_EVENT');
  // Only provider-returned text blocks are displayable; never copy the native stream or event envelope.
  const text = data.message.content
    .filter(
      (block) => record(block) && block.type === 'reasoning' && typeof block.text === 'string',
    )
    .map((block) => block.text)
    .join('\n');
  if (!text) return;
  return {
    source: `native:${session}:${event.seq}:thinking`,
    kind: 'thinking',
    at: new Date(event.time).toISOString(),
    text: redact(text),
    ...(integer(data.turn) && integer(data.step)
      ? { thinkingId: `${data.turn}:${data.step}` }
      : {}),
  };
}

export function projectTranscript(
  note: unknown,
  session: string,
  redact: (value: string) => string,
  prunedResult = false,
): TranscriptEvent | undefined {
  const event = nativeEvent(note, session);
  if (!event) return;
  const data = event.data;
  const base = { source: `native:${session}:${event.seq}`, at: new Date(event.time).toISOString() };
  if (event.type === 'tool/call') {
    if (!short(data.callId) || !short(data.name) || typeof data.arguments !== 'string')
      throw new Fault('INVALID_TRANSCRIPT_EVENT');
    return {
      ...base,
      kind: 'call',
      name: redact(data.name),
      callId: redact(data.callId),
      text: transcriptText(data.arguments, redact),
    };
  }
  if (event.type === 'tool/result') {
    // A compactor's surface replacement is not another tool execution; retain its original result only.
    if (prunedResult) return;
    if (!record(data.message) || !short(data.message.toolCallId))
      throw new Fault('INVALID_TRANSCRIPT_EVENT');
    return {
      ...base,
      kind: 'result',
      callId: redact(data.message.toolCallId),
      isError: data.message.isError === true,
      ...(data.message.isError === true && record(data.error) && publicCode(data.error.code)
        ? { code: data.error.code }
        : {}),
      text: redact(visibleContent(data.message.content, redact)),
    };
  }
  if (event.type === 'assistant/message') {
    if (!record(data.message) || !Array.isArray(data.message.content))
      throw new Fault('INVALID_TRANSCRIPT_EVENT');
    // The native event also carries reasoning and raw streams; select text blocks instead of serializing the envelope.
    const text = data.message.content
      .filter((block) => record(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('');
    return text ? { ...base, kind: 'assistant', text: redact(text) } : undefined;
  }
  if (event.type === 'todo/write') {
    if (!isTaskPlan(data.todos)) throw new Fault('INVALID_TRANSCRIPT_EVENT');
    return { ...base, kind: 'plan', text: redact(JSON.stringify(data.todos, null, 2)) };
  }
}

export class Transcripts {
  readonly ready: Promise<unknown>;
  private db!: Database;
  private closed = false;
  constructor(readonly file: string) {
    this.ready = this.load();
    this.ready.catch(() => {});
  }
  private async load() {
    await secureDirectory(path.dirname(this.file));
    const existing = await lstat(this.file).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error;
      return undefined;
    });
    // Windows ignores O_NOFOLLOW; reject linked entries and verify the handle's identity explicitly.
    if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1))
      throw new Fault('TRANSCRIPT_UNAVAILABLE');
    const handle = await open(
      this.file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        (existing && (stat.dev !== existing.dev || stat.ino !== existing.ino))
      )
        throw new Fault('TRANSCRIPT_UNAVAILABLE');
    } finally {
      await handle.close();
    }
    const client = new DatabaseSync(this.file);
    try {
      configure(client, { journal: 'WAL' });
      this.db = migrate(client, migrations, legacy);
    } catch (error) {
      client.close();
      if (
        error instanceof Error &&
        ['DATABASE_NEWER', 'DATABASE_UNVERSIONED'].includes(error.message)
      )
        throw new Fault('TRANSCRIPT_UNAVAILABLE');
      throw error;
    }
    this.db
      .update(transcriptRuns)
      .set({ state: 'interrupted' })
      .where(eq(transcriptRuns.state, 'recording'))
      .run();
  }
  private find(scope: TranscriptScope) {
    const key = identity(scope);
    if (this.closed || !this.db) throw new Fault('TRANSCRIPT_UNAVAILABLE', 503);
    const row = this.db
      .select({ scope: transcriptRuns.scope, state: transcriptRuns.state })
      .from(transcriptRuns)
      .where(eq(transcriptRuns.run, scope.runId))
      .get();
    if (row && row.scope !== key) throw new Fault('TRANSCRIPT_NOT_FOUND', 404);
    if (row && !['recording', 'complete', 'interrupted'].includes(String(row.state)))
      throw new Fault('TRANSCRIPT_CORRUPT');
    return row;
  }
  begin(scope: TranscriptScope) {
    const key = identity(scope);
    try {
      const prior = this.find(scope);
      if (prior) throw new Fault('TRANSCRIPT_CLOSED');
    } catch (error) {
      if (error instanceof Fault && error.code === 'TRANSCRIPT_NOT_FOUND')
        throw new Fault('TRANSCRIPT_SCOPE_CONFLICT');
      throw error;
    }
    this.db
      .insert(transcriptRuns)
      .values({ run: scope.runId, scope: key, state: 'recording' })
      .run();
  }
  append(scope: TranscriptScope, event: TranscriptEvent) {
    if (this.find(scope)?.state !== 'recording') throw new Fault('TRANSCRIPT_CLOSED');
    const { source, text, ...meta } = event;
    if (
      !short(source) ||
      typeof text !== 'string' ||
      text.length > transcriptEventLimit ||
      !isTranscriptItem({ ...meta, seq: 1, characters: text.length })
    )
      throw new Fault('INVALID_TRANSCRIPT_EVENT');
    // Content offsets are JavaScript UTF-16 offsets, not SQLite's Unicode code-point length().
    const encoded = JSON.stringify({ ...meta, characters: text.length });
    const old = this.db
      .select({
        seq: transcriptEvents.seq,
        meta: transcriptEvents.meta,
        body: transcriptEvents.body,
      })
      .from(transcriptEvents)
      .where(and(eq(transcriptEvents.run, scope.runId), eq(transcriptEvents.source, source)))
      .get();
    if (old) {
      if (old.meta !== encoded || old.body !== text) throw new Fault('TRANSCRIPT_EVENT_CONFLICT');
      return metadata(old.seq, old.meta);
    }
    const last = this.db
      .select({ seq: max(transcriptEvents.seq) })
      .from(transcriptEvents)
      .where(eq(transcriptEvents.run, scope.runId));
    // The next sequence number is computed inside the INSERT so allocation stays one statement.
    const inserted = this.db
      .insert(transcriptEvents)
      .values({
        run: scope.runId,
        seq: sql`coalesce((${last}), 0) + 1`,
        source,
        meta: encoded,
        body: text,
      })
      .returning({ seq: transcriptEvents.seq })
      .get();
    return metadata(inserted.seq, encoded);
  }
  item(scope: TranscriptScope, seq: number) {
    if (!this.find(scope) || !integer(seq) || !seq) throw new Fault('TRANSCRIPT_NOT_FOUND', 404);
    const row = this.db
      .select({ meta: transcriptEvents.meta })
      .from(transcriptEvents)
      .where(and(eq(transcriptEvents.run, scope.runId), eq(transcriptEvents.seq, seq)))
      .get();
    if (!row) throw new Fault('TRANSCRIPT_NOT_FOUND', 404);
    return metadata(seq, row.meta);
  }
  finish(scope: TranscriptScope) {
    if (this.find(scope)?.state !== 'recording') throw new Fault('TRANSCRIPT_CLOSED');
    this.db
      .update(transcriptRuns)
      .set({ state: 'complete' })
      .where(eq(transcriptRuns.run, scope.runId))
      .run();
  }
  interrupt(scope: TranscriptScope) {
    if (this.find(scope)?.state === 'recording')
      this.db
        .update(transcriptRuns)
        .set({ state: 'interrupted' })
        .where(eq(transcriptRuns.run, scope.runId))
        .run();
  }
  page(scope: TranscriptScope, after = 0): TranscriptPage {
    const row = this.find(scope);
    if (!integer(after)) throw new Fault('INVALID_TRANSCRIPT_QUERY', 400);
    const records = row
      ? this.db
          .select({ seq: transcriptEvents.seq, meta: transcriptEvents.meta })
          .from(transcriptEvents)
          .where(and(eq(transcriptEvents.run, scope.runId), gt(transcriptEvents.seq, after)))
          .orderBy(asc(transcriptEvents.seq))
          .limit(transcriptPageLimit + 1)
          .all()
      : [];
    const items = records
      .slice(0, transcriptPageLimit)
      .map((item) => metadata(Number(item.seq), String(item.meta)));
    return {
      ...scope,
      state:
        row?.state === 'recording'
          ? 'recording'
          : row?.state === 'complete'
            ? 'complete'
            : row
              ? 'interrupted'
              : 'unavailable',
      items,
      ...(records.length > transcriptPageLimit ? { nextAfter: items.at(-1)!.seq } : {}),
    };
  }
  content(scope: TranscriptScope, seq: number, offset = 0): TranscriptContent {
    this.find(scope);
    if (!integer(seq) || !seq || !integer(offset)) throw new Fault('INVALID_TRANSCRIPT_QUERY', 400);
    const row = this.db
      .select({ body: transcriptEvents.body })
      .from(transcriptEvents)
      .where(and(eq(transcriptEvents.run, scope.runId), eq(transcriptEvents.seq, seq)))
      .get();
    if (!row) throw new Fault('TRANSCRIPT_NOT_FOUND', 404);
    const body = String(row.body);
    if (offset > body.length) throw new Fault('INVALID_TRANSCRIPT_QUERY', 400);
    const text = body.slice(offset, offset + transcriptChunkLimit);
    return {
      ...scope,
      seq,
      offset,
      total: body.length,
      text,
      ...(offset + text.length < body.length ? { nextOffset: offset + text.length } : {}),
    };
  }
  results(scope: TranscriptScope, after = 0, limit = 5) {
    const row = this.find(scope);
    if (!integer(after) || !integer(limit) || limit < 1 || limit > 20)
      throw new Fault('INVALID_TRANSCRIPT_QUERY', 400);
    const entries = row
      ? this.db
          .select({ seq: transcriptEvents.seq, meta: transcriptEvents.meta })
          .from(transcriptEvents)
          .where(
            and(
              eq(transcriptEvents.run, scope.runId),
              gt(transcriptEvents.seq, after),
              // The builder has no JSON path operator; filter on the stored metadata kind in SQL.
              sql`json_extract(${transcriptEvents.meta}, '$.kind') = 'result'`,
            ),
          )
          .orderBy(asc(transcriptEvents.seq))
          .limit(limit + 1)
          .all()
      : [];
    const results = entries.slice(0, limit).map((entry) => {
      const item = metadata(Number(entry.seq), String(entry.meta));
      return {
        seq: item.seq,
        callId: item.callId || '',
        isError: item.isError === true,
        characters: item.characters,
      };
    });
    return {
      results,
      state: row?.state ?? 'unavailable',
      ...(entries.length > limit ? { nextAfter: results.at(-1)!.seq } : {}),
    };
  }
  result(scope: TranscriptScope, seq: number) {
    // Orphaned event IDs cannot establish Bot/conversation ownership without their run row.
    if (!this.find(scope)) throw new Fault('TRANSCRIPT_NOT_FOUND', 404);
    if (!integer(seq) || !seq) throw new Fault('INVALID_TRANSCRIPT_QUERY', 400);
    const row = this.db
      .select({ meta: transcriptEvents.meta, body: transcriptEvents.body })
      .from(transcriptEvents)
      .where(and(eq(transcriptEvents.run, scope.runId), eq(transcriptEvents.seq, seq)))
      .get();
    if (!row) throw new Fault('TRANSCRIPT_NOT_FOUND', 404);
    const item = metadata(seq, String(row.meta));
    if (item.kind !== 'result') throw new Fault('TRANSCRIPT_NOT_FOUND', 404);
    return { item, text: String(row.body) };
  }
  async close() {
    if (this.closed) return;
    await this.ready.catch(() => {});
    this.closed = true;
    this.db?.$client.close();
  }
}
