import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
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
import { Fault } from './control.js';

export interface TranscriptEvent extends Omit<TranscriptItem, 'seq' | 'characters'> {
  source: string;
  text: string;
}

function transcriptText(text: string, redact: (value: string) => string) {
  try {
    // Serialized tool JSON may escape credential characters; redact decoded values before encoding them again.
    return redact(
      JSON.stringify(
        JSON.parse(text),
        (_key, value: unknown) => (typeof value === 'string' ? redact(value) : value),
        2,
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

export function projectTranscript(
  note: unknown,
  session: string,
  redact: (value: string) => string,
): TranscriptEvent | undefined {
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
  private db!: DatabaseSync;
  private closed = false;
  constructor(readonly file: string) {
    this.ready = this.load();
    this.ready.catch(() => {});
  }
  private async load() {
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const handle = await open(
      this.file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1) throw new Fault('TRANSCRIPT_UNAVAILABLE');
    } finally {
      await handle.close();
    }
    this.db = new DatabaseSync(this.file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS transcript_runs(run TEXT PRIMARY KEY,scope TEXT NOT NULL,state TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS transcript_events(run TEXT NOT NULL,seq INTEGER NOT NULL,source TEXT NOT NULL,meta TEXT NOT NULL,body TEXT NOT NULL,
        PRIMARY KEY(run,seq),UNIQUE(run,source));
      UPDATE transcript_runs SET state='interrupted' WHERE state='recording';`);
  }
  private find(scope: TranscriptScope) {
    const key = identity(scope);
    if (this.closed || !this.db) throw new Fault('TRANSCRIPT_UNAVAILABLE', 503);
    const row = this.db
      .prepare('SELECT scope,state FROM transcript_runs WHERE run=?')
      .get(scope.runId);
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
    this.db.prepare('INSERT INTO transcript_runs VALUES(?,?,?)').run(scope.runId, key, 'recording');
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
      .prepare('SELECT meta,body FROM transcript_events WHERE run=? AND source=?')
      .get(scope.runId, source);
    if (old) {
      if (old.meta !== encoded || old.body !== text) throw new Fault('TRANSCRIPT_EVENT_CONFLICT');
      return;
    }
    this.db
      .prepare(`INSERT INTO transcript_events(run,seq,source,meta,body)
      SELECT ?,COALESCE(MAX(seq),0)+1,?,?,? FROM transcript_events WHERE run=?`)
      .run(scope.runId, source, encoded, text, scope.runId);
  }
  finish(scope: TranscriptScope) {
    if (this.find(scope)?.state !== 'recording') throw new Fault('TRANSCRIPT_CLOSED');
    this.db.prepare("UPDATE transcript_runs SET state='complete' WHERE run=?").run(scope.runId);
  }
  interrupt(scope: TranscriptScope) {
    if (this.find(scope)?.state === 'recording')
      this.db
        .prepare("UPDATE transcript_runs SET state='interrupted' WHERE run=?")
        .run(scope.runId);
  }
  page(scope: TranscriptScope, after = 0): TranscriptPage {
    const row = this.find(scope);
    if (!integer(after)) throw new Fault('INVALID_TRANSCRIPT_QUERY', 400);
    const records = row
      ? this.db
          .prepare(
            'SELECT seq,meta FROM transcript_events WHERE run=? AND seq>? ORDER BY seq LIMIT ?',
          )
          .all(scope.runId, after, transcriptPageLimit + 1)
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
      .prepare('SELECT body FROM transcript_events WHERE run=? AND seq=?')
      .get(scope.runId, seq);
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
  async close() {
    if (this.closed) return;
    await this.ready.catch(() => {});
    this.closed = true;
    this.db?.close();
  }
}
