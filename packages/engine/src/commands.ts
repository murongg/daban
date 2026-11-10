import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type ApprovalMode, isInteractionInput, validAgentId } from '@daban/protocol';
import { and, eq, notInArray } from 'drizzle-orm';
import { migrations } from './commands-migrations.js';
import { commands } from './commands-schema.js';
import type { ToolResult } from './computer-tools.js';
import { errorCode, Fault } from './control.js';
import { configure, type Database, migrate } from './database.js';
import { syncDirectory } from './durability.js';
import type { Interactions } from './interactions.js';

export interface CommandRun {
  id?: string;
  bot: string;
  sessionId?: string;
  conversationId?: string;
  workdir: string;
  root?: string;
  abort: AbortController;
  task?: { prompt: string; approvalMode?: ApprovalMode };
  waitingForComputer?: boolean;
  onComputerWait?: () => unknown;
}
export interface CommandReview {
  approvalMode?: ApprovalMode;
  bot: string;
  runId: string;
  sessionId: string;
  tool: string;
  args: Record<string, unknown>;
  command: string;
  cwd: string;
  root?: string;
  purpose: string;
  target: 'host-local' | 'linux-vm';
}
export interface HostCommandRequest {
  command: string;
  cwd: string;
  root: string;
}
export type HostCommandExecutor = (
  request: HostCommandRequest,
  signal: AbortSignal,
) => Promise<ToolResult>;
export type CommandTarget = CommandReview['target'];
export type CommandDecision = 'allow' | 'ask' | 'deny';
const failure = (code: string): ToolResult => ({
  isError: true,
  content: [{ type: 'text', text: code }],
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(',')}}`;
}

function legacy(client: DatabaseSync) {
  client.exec(
    'CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,request TEXT NOT NULL,phase TEXT NOT NULL,decision TEXT,result TEXT);',
  );
}

export class Commands {
  readonly ready: Promise<unknown>;
  private db?: Database;
  private closed = false;
  private readonly active = new Map<
    string,
    { fingerprint: string; promise: Promise<ToolResult> }
  >();
  constructor(
    readonly options: {
      file: string;
      interactions: Interactions;
      target?: CommandTarget;
      review?: (request: CommandReview, signal?: AbortSignal) => Promise<CommandDecision>;
      assertLive?: (run: CommandRun) => unknown;
    },
  ) {
    this.ready = this.load();
    this.ready.catch(() => {});
  }
  private async load() {
    await mkdir(path.dirname(this.options.file), { recursive: true, mode: 0o700 });
    const handle = await open(
      this.options.file,
      constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1) throw new Fault('COMMAND_STORE_UNAVAILABLE');
    } finally {
      await handle.close();
    }
    await chmod(this.options.file, 0o600);
    const client = new DatabaseSync(this.options.file);
    try {
      configure(client, { journal: 'WAL', synchronous: 'FULL', busyTimeout: 5000 });
      this.db = migrate(client, migrations, legacy);
      this.db
        .update(commands)
        .set({ phase: 'unknown' })
        .where(notInArray(commands.phase, ['settled', 'denied', 'unknown']))
        .run();
    } catch {
      this.db = undefined;
      client.close();
      throw new Fault('COMMAND_STORE_UNAVAILABLE');
    }
    const directory = await open(
      path.dirname(this.options.file),
      constants.O_RDONLY | constants.O_DIRECTORY,
    );
    try {
      await syncDirectory(directory);
    } finally {
      await directory.close();
    }
  }
  private live(run: CommandRun) {
    if (this.closed || run.abort.signal.aborted) throw new Fault('COMMAND_CANCELLED');
    this.options.assertLive?.(run);
  }
  private row(id: string) {
    return this.db!.select({
      fingerprint: commands.fingerprint,
      phase: commands.phase,
      result: commands.result,
    })
      .from(commands)
      .where(eq(commands.id, id))
      .get();
  }
  private finish(id: string, phase: 'settled' | 'denied' | 'unknown', result: ToolResult) {
    this.db!.update(commands)
      .set({ phase, result: JSON.stringify(result) })
      .where(eq(commands.id, id))
      .run();
    return result;
  }
  invoke(
    run: CommandRun,
    tool: string,
    args: Record<string, unknown>,
    wireId: string | undefined,
    dispatch: () => Promise<ToolResult>,
  ): Promise<ToolResult> {
    let request: CommandReview;
    try {
      if (
        !validAgentId(run.id) ||
        !validAgentId(run.bot) ||
        !run.sessionId ||
        run.sessionId.length > 200 ||
        !wireId ||
        wireId.length > 1000
      )
        throw new Fault('COMMAND_INVALID_REQUEST');
      const input = structuredClone(args);
      const target = this.options.target ?? 'linux-vm';
      const fields =
        tool === 'process_input'
          ? ['id', 'data', 'eof']
          : tool === 'local_shell'
            ? ['command', 'folder', 'cwd']
            : ['command'];
      if (
        !(target === 'host-local'
          ? tool === 'local_shell' || tool === 'workspace_shell'
          : ['shell', 'process_start', 'process_input'].includes(tool)) ||
        Object.keys(input).some((key) => !fields.includes(key))
      )
        throw new Fault('COMMAND_INVALID_REQUEST');
      let command: string;
      if (tool === 'process_input') {
        if (
          !validAgentId(input.id) ||
          typeof input.data !== 'string' ||
          input.data.includes('\0') ||
          (input.eof !== undefined && typeof input.eof !== 'boolean')
        )
          throw new Fault('COMMAND_INVALID_REQUEST');
        command = `stdin ${input.id}\n${JSON.stringify(input.data)}${input.eof ? '\nEOF' : ''}`;
      } else {
        if (
          typeof input.command !== 'string' ||
          !input.command.length ||
          input.command.length > 12000 ||
          input.command.includes('\0')
        )
          throw new Fault('COMMAND_INVALID_REQUEST');
        command = input.command;
      }
      if (
        tool === 'local_shell' &&
        (!validAgentId(input.folder) ||
          (input.cwd !== undefined &&
            (typeof input.cwd !== 'string' ||
              input.cwd.length > 4096 ||
              input.cwd.includes('\0') ||
              input.cwd.includes('\\') ||
              path.isAbsolute(input.cwd) ||
              input.cwd.split('/').includes('..'))))
      )
        throw new Fault('COMMAND_INVALID_REQUEST');
      request = {
        ...(run.task?.approvalMode ? { approvalMode: run.task.approvalMode } : {}),
        bot: run.bot,
        runId: run.id,
        sessionId: run.sessionId,
        tool,
        args: input,
        command,
        cwd: run.workdir,
        ...(target === 'host-local' ? { root: run.root } : {}),
        purpose:
          run.task?.prompt.trim().slice(0, 500) ||
          (tool === 'workspace_shell'
            ? 'Run a command in the current local task directory.'
            : target === 'host-local'
              ? 'Run an approved command in a connected local folder.'
              : 'Execute the current Linux VM task.'),
        target,
      };
      if (target === 'host-local' && !run.root) throw new Fault('COMMAND_INVALID_REQUEST');
      if (
        !isInteractionInput({
          id: 'mock-validation',
          sessionId: request.sessionId,
          kind: 'approval',
          ...(target === 'host-local'
            ? {
                tool: 'host_command',
                command,
                cwd: request.cwd,
                root: request.root,
                purpose: request.purpose,
                target,
              }
            : {
                tool: 'vm_command',
                command,
                cwd: request.cwd,
                purpose: request.purpose,
                target,
              }),
        })
      )
        throw new Fault('COMMAND_INVALID_REQUEST');
    } catch {
      return Promise.resolve(failure('COMMAND_INVALID_REQUEST'));
    }
    const id = digest(JSON.stringify([run.bot, run.id, run.sessionId, wireId]));
    const fingerprint = digest(canonical(request));
    const existing = this.active.get(id);
    if (existing)
      return existing.fingerprint === fingerprint
        ? existing.promise
        : Promise.resolve(failure('COMMAND_CALL_ID_REUSED'));
    const promise = this.execute(run, id, fingerprint, request, dispatch).finally(() =>
      this.active.delete(id),
    );
    this.active.set(id, { fingerprint, promise });
    return promise;
  }
  private async execute(
    run: CommandRun,
    id: string,
    fingerprint: string,
    request: CommandReview,
    dispatch: () => Promise<ToolResult>,
  ) {
    let dispatched = false;
    try {
      await this.ready;
      this.live(run);
      const previous = this.row(id);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return failure('COMMAND_CALL_ID_REUSED');
        if (previous.phase === 'settled' || previous.phase === 'denied')
          return previous.result
            ? (JSON.parse(previous.result) as ToolResult)
            : failure('COMMAND_APPROVAL_REJECTED');
        return failure('COMMAND_OUTCOME_UNKNOWN');
      }
      this.db!.insert(commands)
        .values({ id, fingerprint, request: canonical(request), phase: 'reviewing' })
        .run();
      const decision =
        request.tool === 'local_shell' || request.approvalMode === 'ask'
          ? 'ask'
          : request.tool === 'workspace_shell' || request.approvalMode === 'full'
            ? 'allow'
            : await (this.options.review?.(structuredClone(request), run.abort.signal) ?? 'ask');
      this.live(run);
      if (decision !== 'allow' && decision !== 'ask')
        return this.finish(id, 'denied', failure('COMMAND_APPROVAL_REJECTED'));
      if (decision === 'ask') {
        const previous = (await this.options.interactions.list()).find((item) => item.id === id);
        if (previous) return this.finish(id, 'unknown', failure('COMMAND_OUTCOME_UNKNOWN'));
        await this.options.interactions.open(
          run.bot,
          run.id!,
          {
            id,
            sessionId: run.sessionId!,
            kind: 'approval',
            tool: request.target === 'host-local' ? 'host_command' : 'vm_command',
            command: request.command,
            cwd: request.cwd,
            ...(request.target === 'host-local' && request.root ? { root: request.root } : {}),
            purpose: request.purpose,
            target: request.target,
          },
          run.conversationId,
        );
        run.waitingForComputer = true;
        run.onComputerWait?.();
        try {
          let approval = await this.options.interactions.wait(
            run.bot,
            run.id!,
            id,
            run.abort.signal,
          );
          while (approval.status === 'pending') {
            this.live(run);
            approval = await this.options.interactions.wait(run.bot, run.id!, id, run.abort.signal);
          }
          this.live(run);
          if (
            approval.status !== 'resolved' ||
            approval.reply?.kind !== 'decision' ||
            !approval.reply.allow
          )
            return this.finish(id, 'denied', failure('COMMAND_APPROVAL_REJECTED'));
        } finally {
          run.waitingForComputer = false;
          run.onComputerWait?.();
        }
      }
      this.live(run);
      // Persist the one-use claim before crossing into the guest; a restart may only inspect this receipt.
      const claimed = this.db!.update(commands)
        .set({ phase: 'dispatching', decision })
        .where(and(eq(commands.id, id), eq(commands.phase, 'reviewing')))
        .run();
      if (Number(claimed.changes) !== 1) return failure('COMMAND_OUTCOME_UNKNOWN');
      await new Promise((resolve) => setImmediate(resolve));
      this.live(run);
      dispatched = true;
      const result = await dispatch();
      return this.finish(id, 'settled', result);
    } catch (error) {
      const code = run.abort.signal.aborted
        ? 'COMMAND_CANCELLED'
        : dispatched
          ? 'COMMAND_OUTCOME_UNKNOWN'
          : errorCode(error) || 'COMMAND_UNAVAILABLE';
      const result = failure(code);
      try {
        if (this.db && this.row(id)) {
          return this.finish(id, dispatched ? 'unknown' : 'denied', result);
        }
      } catch {
        return failure(dispatched ? 'COMMAND_OUTCOME_UNKNOWN' : 'COMMAND_STORE_UNAVAILABLE');
      }
      return result;
    }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.active.values()].map((item) => item.promise));
    await this.ready.catch(() => {});
    this.db?.$client.close();
    this.db = undefined;
  }
}
