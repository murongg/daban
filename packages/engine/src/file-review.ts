import { createHash, createHmac, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  compareReviewPaths,
  isReviewFile,
  isReviewPage,
  isReviewSelection,
  isReviewSnapshot,
  isTranscriptScope,
  type ReviewArea,
  type ReviewCapture,
  type ReviewCurrent,
  type ReviewDiff,
  type ReviewFileQuery,
  type ReviewPage,
  type ReviewQuery,
  type ReviewReason,
  type ReviewState,
  reviewFileKey,
  sameTranscriptScope,
  type TranscriptScope,
} from '@daban/protocol';
import { Fault } from './control.js';
import { compareFiles, diffText } from './file-diff.js';
import { privateMetadata, secureDirectory } from './private-files.js';
import { checkedReviewCapture } from './workspace-review.js';

export interface ReviewRoot {
  root: string;
  canonical: string;
}
export interface ReviewRoots {
  task?: ReviewRoot;
  shared?: ReviewRoot;
}
export type ReviewPointer = { revision: number; state: ReviewState };
interface Head extends ReviewPointer {
  published: number[];
  scope: TranscriptScope;
  sharedPaths: string[];
  roots: ReviewRoots;
  secret: string;
  terminalAt?: number;
}
interface Report {
  scope: TranscriptScope;
  revision: number;
  state: ReviewState;
  before: ReviewCapture[];
  after: ReviewCapture[];
  reasons: ReviewReason[];
}
const terminal = (state: ReviewState) =>
  ['complete', 'interrupted', 'unavailable', 'expired'].includes(state);
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const keyFor = (scope: TranscriptScope) =>
  digest(
    JSON.stringify({
      bot: scope.bot,
      runId: scope.runId,
      ...(scope.conversationId
        ? { conversationId: scope.conversationId }
        : { chatRevision: scope.chatRevision }),
    }),
  );
const emptyCounts = () => ({ created: 0, modified: 0, deleted: 0, unchanged: 0, unknown: 0 });
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const emptyPage = (
  scope: TranscriptScope,
  state: ReviewState,
  reason: ReviewReason,
  revision = 1,
): ReviewPage => ({
  scope,
  revision,
  state,
  writers: 'unknown',
  effects: 'unknown',
  reasons: [reason],
  counts: emptyCounts(),
  items: [],
});

export class FileReviews {
  readonly ready: Promise<unknown>;
  private writing: Promise<unknown> = Promise.resolve();
  private readonly pending = new Set<Promise<unknown>>();
  private closing?: Promise<unknown>;
  private readonly now: () => number;
  constructor(
    readonly directory: string,
    readonly options: {
      now?: () => number;
      maxBytes?: number;
      maxRuns?: number;
      maxAge?: number;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ready = this.load();
  }
  private runDirectory(scope: TranscriptScope) {
    return path.join(this.directory, keyFor(scope));
  }
  private async privateRead(file: string, max: number) {
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > max ||
        !(await privateMetadata(file, info, 0o600))
      )
        throw new Error('FILE_REVIEW_CORRUPT');
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }
  private async head(scope: TranscriptScope): Promise<Head | undefined> {
    const directory = this.runDirectory(scope);
    if (!(await lstat(directory).catch(() => undefined))) return undefined;
    await secureDirectory(directory);
    const value: unknown = JSON.parse(
      (await this.privateRead(path.join(directory, 'head.json'), 16384)).toString('utf8'),
    );
    if (
      !object(value) ||
      !isTranscriptScope(value.scope) ||
      !sameTranscriptScope(scope, value.scope) ||
      !isReviewSelection({ sharedPaths: value.sharedPaths }) ||
      !Number.isSafeInteger(value.revision) ||
      Number(value.revision) < 1 ||
      !Array.isArray(value.published) ||
      value.published.length < 1 ||
      value.published.length > 8 ||
      value.published.at(-1) !== value.revision ||
      !value.published.every(
        (revision, i, all) =>
          Number.isSafeInteger(revision) && revision >= 1 && (i === 0 || revision > all[i - 1]),
      ) ||
      typeof value.secret !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.secret) ||
      !object(value.roots) ||
      Object.keys(value.roots).some((area) => !['task', 'shared'].includes(area)) ||
      Object.values(value.roots).some(
        (root) =>
          !object(root) || typeof root.root !== 'string' || typeof root.canonical !== 'string',
      ) ||
      ![
        'capturing-before',
        'recording',
        'capturing-after',
        'complete',
        'interrupted',
        'unavailable',
        'expired',
      ].includes(String(value.state)) ||
      (value.terminalAt !== undefined &&
        (typeof value.terminalAt !== 'number' || !Number.isFinite(value.terminalAt)))
    )
      throw new Error('FILE_REVIEW_CORRUPT');
    const head = value as unknown as Head;
    if (
      head.state !== 'expired' &&
      head.terminalAt !== undefined &&
      this.now() - head.terminalAt > (this.options.maxAge ?? 30 * 86400000)
    ) {
      await this.expire(head);
      return { ...head, state: 'expired' };
    }
    return head;
  }
  private async atomic(directory: string, name: string, data: string) {
    const temporary = path.join(directory, `${name}.${randomBytes(8).toString('hex')}.tmp`);
    try {
      await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
      await rename(temporary, path.join(directory, name));
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  private async load() {
    await secureDirectory(this.directory);
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      try {
        const raw: unknown = JSON.parse(
          (await this.privateRead(path.join(this.directory, name, 'head.json'), 16384)).toString(
            'utf8',
          ),
        );
        if (!object(raw) || !isTranscriptScope(raw.scope) || keyFor(raw.scope) !== name) continue;
        const head = await this.head(raw.scope);
        if (head && !terminal(head.state)) {
          const prior = await this.report(head, head.revision, false).catch(
            (): Report => ({
              scope: head.scope,
              revision: head.revision,
              state: head.state,
              before: [],
              after: [],
              reasons: ['corrupt'],
            }),
          );
          await this.publish(head, {
            ...prior,
            state: 'interrupted',
            reasons: [...new Set([...prior.reasons, 'disconnected' as const])],
          });
        }
      } catch {
        /* A corrupt review must never hide its TaskJournal record or prevent other reviews opening. */
      }
    }
    await this.cleanup();
  }
  private accept<T>(operation: () => Promise<T>) {
    if (this.closing) return Promise.reject(new Fault('FILE_REVIEW_CLOSED', 503));
    // Reads can expire evidence too; track their lifetime without serializing them behind writes.
    const result: Promise<T> = Promise.resolve()
      .then(operation)
      .finally(() => this.pending.delete(result));
    this.pending.add(result);
    return result;
  }
  private enqueue<T>(operation: () => Promise<T>) {
    return this.accept(() => {
      const write = async () => {
        await this.ready;
        return operation();
      };
      const result = this.writing.then(write, write);
      this.writing = result.catch(() => undefined);
      return result;
    });
  }
  private async report(head: Head, revision: number, verifyBlobs = true): Promise<Report> {
    if (head.state === 'expired' || !head.published.includes(revision))
      throw new Fault('STALE_FILE_REVIEW', 409);
    let value: unknown;
    try {
      value = JSON.parse(
        (
          await this.privateRead(
            path.join(this.runDirectory(head.scope), `report-${revision}.json`),
            24 * 1024 * 1024,
          )
        ).toString('utf8'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Fault('STALE_FILE_REVIEW', 409);
      throw error;
    }
    if (
      !object(value) ||
      !isTranscriptScope(value.scope) ||
      !sameTranscriptScope(value.scope, head.scope) ||
      value.revision !== revision ||
      !Array.isArray(value.before) ||
      !Array.isArray(value.after) ||
      value.before.length > 2 ||
      value.after.length > 2
    )
      throw new Error('FILE_REVIEW_CORRUPT');
    const captures = [...value.before, ...value.after];
    for (const capture of captures) {
      if (
        !object(capture) ||
        !isReviewSnapshot(capture.snapshot) ||
        !Array.isArray(capture.files) ||
        capture.files.length > 2000 ||
        !capture.files.every(isReviewFile) ||
        !Array.isArray(capture.texts) ||
        capture.texts.length !== 0 ||
        !capture.files.every(
          (file, index, files) =>
            file.area === (capture.snapshot as { area: ReviewArea }).area &&
            (index === 0 ||
              compareReviewPaths(reviewFileKey(files[index - 1]), reviewFileKey(file)) < 0),
        )
      )
        throw new Error('FILE_REVIEW_CORRUPT');
    }
    const report = value as unknown as Report;
    const page = this.page(report, 0);
    if (!isReviewPage(page)) throw new Error('FILE_REVIEW_CORRUPT');
    for (const side of [report.before, report.after])
      if (new Set(side.map((capture) => capture.snapshot.area)).size !== side.length)
        throw new Error('FILE_REVIEW_CORRUPT');
    if (verifyBlobs) {
      const seen = new Set<string>();
      for (const capture of captures)
        for (const file of (capture as ReviewCapture).files)
          if (file.state === 'present' && file.text && !seen.has(file.sha256)) {
            await this.blob(head, file.sha256, file.bytes);
            seen.add(file.sha256);
          }
    }
    return report;
  }
  private async blob(head: Head, sha256: string, bytes: number) {
    const data = await this.privateRead(
      path.join(this.runDirectory(head.scope), sha256),
      256 * 1024,
    );
    if (data.length !== bytes || digest(data) !== sha256 || data.includes(0))
      throw new Error('FILE_REVIEW_CORRUPT');
    new TextDecoder('utf-8', { fatal: true }).decode(data);
    return data.toString('utf8');
  }
  private page(report: Report, offset: number): ReviewPage {
    const items = compareFiles(report.before, report.after);
    const counts = emptyCounts();
    for (const item of items) counts[item.kind]++;
    return {
      scope: report.scope,
      revision: report.revision,
      state: report.state,
      writers: 'unknown',
      effects: 'partial',
      reasons: [
        ...new Set([
          'unbounded-writer' as const,
          ...report.reasons,
          ...[...report.before, ...report.after].flatMap((capture) => capture.snapshot.reasons),
        ]),
      ],
      before: report.before.map((capture) => capture.snapshot),
      after: report.after.map((capture) => capture.snapshot),
      counts,
      items: items.slice(offset, offset + 200),
    };
  }
  private async publish(head: Head, report: Report, reserved = false) {
    let revision = head.revision + 1;
    const directory = this.runDirectory(head.scope);
    // A crash can leave an unreferenced report; skip its number rather than replacing any immutable evidence.
    for (
      let attempts = 0;
      await lstat(path.join(directory, `report-${revision}.json`)).catch(() => undefined);
      attempts++
    ) {
      if (attempts === 64) throw new Error('FILE_REVIEW_CORRUPT');
      revision++;
    }
    const next = { ...report, revision };
    const data = JSON.stringify(next);
    await this.cleanup(Buffer.byteLength(data) + (reserved ? 0 : 4096));
    if (
      (await this.usage()) + Buffer.byteLength(data) >
      (this.options.maxBytes ?? 512 * 1024 * 1024) - (reserved ? 0 : 4096)
    )
      throw new Fault('FILE_REVIEW_STORAGE_LIMIT', 507);
    // A published revision is immutable. Only the tiny head pointer advances after its full report is durable.
    await writeFile(path.join(directory, `report-${revision}.json`), data, {
      flag: 'wx',
      mode: 0o600,
    });
    const updated: Head = {
      ...head,
      revision,
      published: [...head.published, revision],
      state: report.state,
      ...(terminal(report.state) ? { terminalAt: this.now() } : {}),
    };
    await this.atomic(directory, 'head.json', JSON.stringify(updated));
    return { revision, state: report.state };
  }
  private async saveCaptures(head: Head, captures: ReviewCapture[]) {
    if (
      captures.length > 2 ||
      new Set(captures.map((capture) => capture.snapshot.area)).size !== captures.length
    )
      throw new Error('FILE_REVIEW_CORRUPT');
    const checked = captures.map(checkedReviewCapture);
    const blobs = new Map<string, Buffer>();
    for (const capture of checked) {
      if (
        capture.snapshot.area === 'shared' &&
        capture.files.some((file) => !head.sharedPaths.includes(file.path))
      )
        throw new Error('FILE_REVIEW_CORRUPT');
      for (const text of capture.texts) {
        const file = capture.files.find((file) => file.path === text.path);
        if (file?.state !== 'present') throw new Error('FILE_REVIEW_CORRUPT');
        const bytes = Buffer.from(text.data, 'base64');
        // Revalidate at the persistence boundary even when capture was supplied by an in-process adapter.
        if (digest(bytes) !== file.sha256) throw new Error('FILE_REVIEW_CORRUPT');
        blobs.set(file.sha256, bytes);
      }
    }
    const directory = this.runDirectory(head.scope);
    let additional = 0;
    for (const [hash, bytes] of blobs) {
      if (await lstat(path.join(directory, hash)).catch(() => undefined))
        await this.blob(head, hash, bytes.length);
      else additional += bytes.length;
    }
    await this.cleanup(additional + 4096);
    if ((await this.usage()) + additional > (this.options.maxBytes ?? 512 * 1024 * 1024) - 4096)
      throw new Fault('FILE_REVIEW_STORAGE_LIMIT', 507);
    for (const [hash, bytes] of blobs) {
      try {
        await writeFile(path.join(directory, hash), bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.blob(head, hash, bytes.length);
      }
    }
    return checked.map((capture) => ({ ...structuredClone(capture), texts: [] }));
  }
  async begin(scope: TranscriptScope, sharedPaths: string[] = []): Promise<ReviewPointer> {
    return this.enqueue(async () => {
      if (!isTranscriptScope(scope) || !isReviewSelection({ sharedPaths }))
        throw new Fault('INVALID_FILE_REVIEW', 400);
      await this.cleanup();
      const existing = await this.head(scope);
      if (existing) return { revision: existing.revision, state: existing.state };
      const directory = this.runDirectory(scope);
      await secureDirectory(directory);
      const head: Head = {
        scope: structuredClone(scope),
        sharedPaths: [...sharedPaths],
        roots: {},
        secret: randomBytes(32).toString('hex'),
        revision: 0,
        published: [],
        state: 'capturing-before',
      };
      try {
        return await this.publish(head, {
          scope: head.scope,
          revision: 0,
          state: 'capturing-before',
          before: [],
          after: [],
          reasons: [],
        });
      } catch (error) {
        if (!(error instanceof Fault) || error.code !== 'FILE_REVIEW_STORAGE_LIMIT') throw error;
        // No head exists yet: use the reserved space so a quota failure cannot masquerade as corrupt evidence.
        return this.publish(
          head,
          {
            scope: head.scope,
            revision: 0,
            state: 'unavailable',
            before: [],
            after: [],
            reasons: ['storage-limit'],
          },
          true,
        );
      }
    });
  }
  async before(
    scope: TranscriptScope,
    captures: ReviewCapture[],
    roots: ReviewRoots,
  ): Promise<ReviewPointer> {
    return this.enqueue(async () => {
      const head = await this.head(scope);
      if (!head) throw new Fault('FILE_REVIEW_NOT_FOUND', 404);
      if (head.state !== 'capturing-before') return { revision: head.revision, state: head.state };
      const before = await this.saveCaptures(head, captures);
      const shared = before.find((capture) => capture.snapshot.area === 'shared');
      if (shared) {
        shared.files = head.sharedPaths
          .map((name) => {
            const file = shared.files.find((file) => file.path === name);
            return file?.state === 'present'
              ? file
              : {
                  area: 'shared' as const,
                  path: name,
                  state: 'unknown' as const,
                  reason: 'baseline-missing' as const,
                };
          })
          .sort((a, b) => compareReviewPaths(a.path, b.path));
      }
      return this.publish(
        { ...head, roots: structuredClone(roots) },
        { scope, revision: head.revision, state: 'recording', before, after: [], reasons: [] },
      );
    });
  }
  async finish(
    scope: TranscriptScope,
    captures: ReviewCapture[],
    reasons: ReviewReason[] = [],
  ): Promise<ReviewPointer> {
    return this.enqueue(async () => {
      const head = await this.head(scope);
      if (!head) throw new Fault('FILE_REVIEW_NOT_FOUND', 404);
      if (terminal(head.state)) return { revision: head.revision, state: head.state };
      const prior = await this.report(head, head.revision, false);
      let after = await this.saveCaptures(head, captures);
      const sharedBefore = prior.before.find((capture) => capture.snapshot.area === 'shared');
      if (sharedBefore) {
        const sharedAfter = after.find((capture) => capture.snapshot.area === 'shared');
        const files = sharedBefore.files.map((file) =>
          file.state !== 'present'
            ? file
            : (sharedAfter?.files.find((candidate) => candidate.path === file.path) ?? {
                area: 'shared' as const,
                path: file.path,
                state: 'unknown' as const,
                reason: 'baseline-missing' as const,
              }),
        );
        after = after.filter((capture) => capture.snapshot.area !== 'shared');
        after.push({
          snapshot: sharedAfter?.snapshot ?? {
            ...sharedBefore.snapshot,
            capture: 'unknown',
            reasons: ['baseline-missing'],
          },
          files,
          texts: [],
        });
      }
      const pointer = await this.publish(head, {
        ...prior,
        state: prior.before.length ? 'complete' : 'unavailable',
        after,
        reasons,
      });
      await this.cleanup();
      return pointer;
    });
  }
  async finalizing(scope: TranscriptScope): Promise<ReviewPointer> {
    return this.enqueue(async () => {
      const head = await this.head(scope);
      if (!head) throw new Fault('FILE_REVIEW_NOT_FOUND', 404);
      if (head.state !== 'recording') return { revision: head.revision, state: head.state };
      const prior = await this.report(head, head.revision, false);
      return this.publish(head, { ...prior, state: 'capturing-after' });
    });
  }
  async unavailable(scope: TranscriptScope, reason: ReviewReason): Promise<ReviewPointer> {
    return this.enqueue(async () => {
      const head = await this.head(scope);
      if (!head) throw new Fault('FILE_REVIEW_NOT_FOUND', 404);
      if (terminal(head.state)) return { revision: head.revision, state: head.state };
      return this.publish(
        head,
        {
          scope,
          revision: head.revision,
          state: 'unavailable',
          before: [],
          after: [],
          reasons: [reason],
        },
        true,
      );
    });
  }
  private token(head: Head, revision: number, offset: number) {
    const position = `${revision}-${offset}`;
    return `${position}-${createHmac('sha256', head.secret)
      .update(`${keyFor(head.scope)}:${position}`)
      .digest('hex')}`;
  }
  read(query: ReviewQuery): Promise<ReviewPage> {
    return this.accept(() => this.readPage(query));
  }
  private async readPage(query: ReviewQuery): Promise<ReviewPage> {
    await this.ready;
    let head: Head | undefined;
    try {
      head = await this.head(query.scope);
    } catch {
      return emptyPage(query.scope, 'unavailable', 'corrupt');
    }
    if (!head) {
      if (query.cursor) throw new Fault('STALE_FILE_REVIEW', 409);
      return emptyPage(query.scope, 'unavailable', 'baseline-missing');
    }
    if (head.state === 'expired') {
      if (query.cursor) throw new Fault('STALE_FILE_REVIEW', 409);
      return emptyPage(query.scope, 'expired', 'expired', head.revision);
    }
    let revision = head.revision,
      offset = 0;
    if (query.cursor) {
      const match = /^(\d+)-(\d+)-[a-f0-9]{64}$/.exec(query.cursor);
      if (!match) throw new Fault('STALE_FILE_REVIEW', 409);
      revision = Number(match[1]);
      offset = Number(match[2]);
      if (
        !Number.isSafeInteger(offset) ||
        offset < 200 ||
        offset % 200 !== 0 ||
        this.token(head, revision, offset) !== query.cursor
      )
        throw new Fault('STALE_FILE_REVIEW', 409);
    }
    try {
      const report = await this.report(head, revision);
      const page = this.page(report, offset);
      const total = Object.values(page.counts).reduce((sum, count) => sum + count, 0);
      if (query.cursor && offset >= total) throw new Fault('STALE_FILE_REVIEW', 409);
      if (offset + 200 < total) page.next = this.token(head, revision, offset + 200);
      return page;
    } catch (error) {
      if (error instanceof Fault) throw error;
      return emptyPage(query.scope, 'unavailable', 'corrupt', revision);
    }
  }
  private async entry(query: ReviewFileQuery) {
    const head = await this.head(query.scope);
    if (!head) throw new Fault('FILE_REVIEW_NOT_FOUND', 404);
    const report = await this.report(head, query.revision);
    const entry = compareFiles(report.before, report.after).find(
      (item) => item.before.area === query.area && item.before.path === query.path,
    );
    if (!entry) throw new Fault('FILE_REVIEW_NOT_FOUND', 404);
    return { head, report, entry };
  }
  diff(query: ReviewFileQuery): Promise<ReviewDiff> {
    return this.accept(() => this.readDiff(query));
  }
  private async readDiff(query: ReviewFileQuery): Promise<ReviewDiff> {
    await this.ready;
    try {
      const { head, report, entry } = await this.entry(query);
      const values: string[] = [];
      for (const [file, captures] of [
        [entry.before, report.before],
        [entry.after, report.after],
      ] as const) {
        if (file.state === 'unknown')
          return { ...query, state: 'unavailable', reason: file.reason };
        if (file.state === 'absent') values.push('');
        else if (!file.text) {
          // Without retained bytes, an exhausted text budget cannot establish that a file is binary.
          const limited =
            file.bytes > 256 * 1024 ||
            captures.some(
              (capture) =>
                capture.snapshot.area === file.area &&
                capture.snapshot.reasons.includes('text-limit'),
            );
          return { ...query, state: 'unavailable', reason: limited ? 'text-limit' : 'binary' };
        } else values.push(await this.blob(head, file.sha256, file.bytes));
      }
      return { ...query, ...diffText(values[0], values[1]) };
    } catch (error) {
      if (error instanceof Fault) throw error;
      return { ...query, state: 'unavailable', reason: 'corrupt' };
    }
  }
  current(
    query: ReviewFileQuery,
    reader: (root: ReviewRoot, paths: string[]) => Promise<ReviewCapture>,
  ): Promise<ReviewCurrent> {
    return this.accept(() => this.readCurrent(query, reader));
  }
  private async readCurrent(
    query: ReviewFileQuery,
    reader: (root: ReviewRoot, paths: string[]) => Promise<ReviewCapture>,
  ): Promise<ReviewCurrent> {
    await this.ready;
    const unknown: ReviewCurrent = { ...query, state: 'unknown' };
    try {
      const { head, entry } = await this.entry(query);
      const root = head.roots[query.area];
      if (
        !root ||
        entry.after.state !== 'present' ||
        (query.area === 'shared' &&
          (entry.before.state !== 'present' || !head.sharedPaths.includes(query.path)))
      )
        return unknown;
      const capture = checkedReviewCapture(await reader(root, [query.path]));
      const current = capture.files.find((file) => file.path === query.path);
      if (current?.state === 'absent') return { ...query, state: 'missing' };
      if (current?.state !== 'present') return unknown;
      return { ...query, state: current.sha256 === entry.after.sha256 ? 'matching' : 'changed' };
    } catch (error) {
      if (
        error instanceof Fault &&
        ['FILE_REVIEW_NOT_FOUND', 'STALE_FILE_REVIEW'].includes(error.message)
      )
        throw error;
      return unknown;
    }
  }
  private async usage() {
    let bytes = 0;
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      const directory = path.join(this.directory, name);
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      for (const file of await readdir(directory)) {
        const stat = await lstat(path.join(directory, file));
        if (stat.isFile() && !stat.isSymbolicLink()) bytes += stat.size;
      }
    }
    return bytes;
  }
  private async cleanup(required = 0) {
    const ended: Head[] = [];
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}$/.test(name)) continue;
      try {
        const raw: unknown = JSON.parse(
          (await this.privateRead(path.join(this.directory, name, 'head.json'), 16384)).toString(
            'utf8',
          ),
        );
        if (!object(raw) || !isTranscriptScope(raw.scope) || keyFor(raw.scope) !== name) continue;
        const head = await this.head(raw.scope);
        if (head && head.terminalAt !== undefined && head.state !== 'expired') ended.push(head);
      } catch {
        /* Do not delete resources whose provenance cannot be established. */
      }
    }
    ended.sort((a, b) => a.terminalAt! - b.terminalAt!);
    while (ended.length) {
      const oldest = ended[0];
      if (
        this.now() - oldest.terminalAt! <= (this.options.maxAge ?? 30 * 86400000) &&
        ended.length <= (this.options.maxRuns ?? 64) &&
        (await this.usage()) + required <= (this.options.maxBytes ?? 512 * 1024 * 1024)
      )
        break;
      ended.shift();
      await this.expire(oldest);
    }
  }
  private async expire(head: Head) {
    const directory = this.runDirectory(head.scope);
    // Persist the expired marker before retiring this owner's evidence; active runs never enter this queue.
    await this.atomic(directory, 'head.json', JSON.stringify({ ...head, state: 'expired' }));
    for (const file of await readdir(directory))
      if (/^(?:[a-f0-9]{64}|report-\d+\.json)$/.test(file))
        await unlink(path.join(directory, file)).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error;
        });
  }
  close() {
    // Seal admission synchronously, including calls already waiting for initialization.
    this.closing ??= Promise.allSettled([this.ready, ...this.pending]).then(([initialized]) => {
      if (initialized.status === 'rejected') throw initialized.reason;
    });
    return this.closing;
  }
}
