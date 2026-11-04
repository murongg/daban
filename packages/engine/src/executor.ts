import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import path from 'node:path';
import type { ExecutionRequest, ExecutionRun, ExecutionSnapshot } from '@daban/protocol';
import {
  browserTaskCapability,
  executionCapabilities,
  executionKeys,
  executionRecord,
  isBrowserAnswerRequest,
  isBrowserBinding,
  isBrowserCommandRequest,
  isBrowserInput,
  isComputerRequest,
  isDocumentUpload,
  isExecutionRequest,
  isProjectFileScope,
  isSkillPackage,
  modelExecutionCapability,
  type ProjectFileScope,
  type ProjectScope,
  projectCapability,
  projectReduction,
  skillPackageCapability,
  validAgentId,
} from '@daban/protocol';
import type { AgentToolRun } from './agent-tools.js';
import { AgentTools } from './agent-tools.js';
import { Authority, ViewerGrants } from './authority.js';
import type { ToolResult } from './computer-tools.js';
import { Computers } from './computers.js';
import { errorCode, Fault } from './control.js';
import { Documents } from './documents.js';
import { syncDirectory } from './durability.js';
import { Machine } from './machine.js';
import type { ProcessSnapshot } from './processes.js';
import { ProcessManager } from './processes.js';
import { ProjectResources } from './project-resources.js';
import type { WorkspaceDirectory } from './workspace.js';
import { WorkspaceFiles } from './workspace.js';

interface Operation {
  digest: string;
  phase: 'running' | 'settled';
  result?: ToolResult;
  done: Promise<unknown>;
}
interface GuestRun {
  description: string;
  run: AgentToolRun;
  operations: Map<string, Operation>;
  writes: Set<Promise<unknown>>;
  processes: Set<string>;
  closing: boolean;
  draining?: Promise<unknown>;
}
interface Handle {
  project?: ProjectFileScope;
  directory: WorkspaceDirectory;
  queue: Promise<unknown>;
  abort: AbortController;
  closing: boolean;
}
const stable = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    executionRecord(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const processToolList = [
  {
    name: 'process_start',
    description:
      'Start a persistent Bash command in the Linux guest, with the actual task directory as cwd. Use relative output paths or the actual task directory from the request; /workspace and /shared are file-tool aliases and are not mounted here. Full guest files, network and passwordless sudo are available. Returns a process id; poll it rather than starting the command again. When using noclobber, create and write a new file in one step; do not precreate it before >, or bypass an existing-file conflict.',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', maxLength: 64000 } },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'process_poll',
    description:
      'Read the bounded output and actual state of an existing guest process. Unknown never means it is safe to rerun.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'process_input',
    description:
      'Write input once to an existing guest process. Set eof to close its input after writing.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        data: { type: 'string', maxLength: 65536 },
        eof: { type: 'boolean' },
      },
      required: ['id', 'data'],
      additionalProperties: false,
    },
  },
  {
    name: 'process_cancel',
    description:
      'Stop an existing guest process and its process group, then read the cancellation receipt.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
];
function send(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 8 * 1024 * 1024) throw new Fault('EXECUTION_BODY_LIMIT', 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!executionRecord(value)) throw new Error('object required');
    return value;
  } catch {
    throw new Fault('EXECUTION_INVALID_REQUEST', 400);
  }
}
function browserInput(value: Record<string, unknown>) {
  if (
    !executionKeys(value, ['epoch', 'binding', 'input']) ||
    !Number.isSafeInteger(value.epoch) ||
    Number(value.epoch) < 0 ||
    !isBrowserBinding(value.binding) ||
    !isBrowserInput(value.input)
  )
    throw new Fault('INVALID_INPUT', 400);
  return { epoch: Number(value.epoch), binding: value.binding, input: value.input };
}
export interface ExecutorOptions {
  directory?: string;
  workspace?: string;
  profileDir?: string;
  desktopDir?: string;
  port?: number;
  boot?: string;
  limit?: number;
}
export async function startExecutor(options: ExecutorOptions = {}) {
  const directory = path.resolve(options.directory || '/var/lib/daban-executor');
  const shared = path.resolve(options.workspace || path.join(directory, 'desktops/shared'));
  const profileDir = path.resolve(options.profileDir || path.join(directory, 'profile'));
  const desktopDir = path.resolve(options.desktopDir || path.join(directory, 'desktops'));
  await Promise.all(
    [directory, shared, profileDir, desktopDir].map((file) =>
      mkdir(file, { recursive: true, mode: 0o700 }),
    ),
  );
  const boot = options.boot || (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  if (!validAgentId(boot)) throw new Fault('EXECUTION_INVALID_BOOT');
  const nonce = randomUUID();
  const authority = new Authority(path.join(directory, 'token'));
  const viewers = new ViewerGrants();
  const workspace = new WorkspaceFiles(shared);
  const legacyRoot = await workspace.base();
  const projects = new ProjectResources(path.join(directory, 'projects'), {
    legacyRoot,
    prepare: (profile) => machine.checkProfile(profile, computers.control),
    changing: (previous, next) => {
      if (!previous || projectReduction(previous.project, next.project)) return;
      const bots = new Set(
        [...previous.project.grants, ...next.project.grants].map((grant) => grant.bot),
      );
      for (const bot of bots) {
        try {
          computers.assertStable(bot);
        } catch {
          throw new Fault('PROJECT_BUSY');
        }
      }
      if (
        [...bots].some(
          (bot) =>
            computers.available(bot) ||
            [...runs.values()].some((value) => value.run.bot === bot && !value.closing),
        )
      )
        throw new Fault('PROJECT_BUSY');
    },
  });
  // Legacy receipts remain available even when the project mirror fails closed.
  await projects.ready.catch(() => undefined);
  const processes = new ProcessManager({ directory: path.join(directory, 'processes'), boot });
  const documents = new Documents();
  const runs = new Map<string, GuestRun>();
  const opening = new Map<string, { description: string; promise: Promise<unknown> }>();
  const closedDirectory = path.join(directory, 'closed-runs');
  await mkdir(closedDirectory, { recursive: true, mode: 0o700 });
  const closedInfo = await lstat(closedDirectory);
  if (
    !closedInfo.isDirectory() ||
    closedInfo.isSymbolicLink() ||
    closedInfo.uid !== process.getuid?.() ||
    (closedInfo.mode & 0o777) !== 0o700
  )
    throw new Fault('EXECUTION_RUN_STORE_FAILED');
  const handles = new Map<string, Handle>();
  const operationContext = new AsyncLocalStorage<string>();
  let computers: Computers;
  let machine: Machine;
  const bindings = new Map<string, ProjectScope>();
  let tools: AgentTools;
  let ready = false;
  let origin = '';
  const server = createServer(async (request, response) => {
    let id = 'invalid-request';
    const abort = new AbortController();
    request.once('aborted', () => abort.abort());
    response.once('close', () => {
      if (!response.writableEnded) abort.abort();
    });
    try {
      const url = new URL(request.url || '/', 'http://guest.invalid');
      const viewer = url.pathname.match(/^\/viewer\/([a-zA-Z0-9_-]{1,80})(\/input)?$/);
      if (viewer) {
        const [, bot, action] = viewer;
        const instance = viewers.instance(request.headers['x-prototype-token'], bot);
        if (!instance) throw new Fault('UNAUTHORIZED', 403);
        if (!ready) throw new Fault('EXECUTION_STARTING', 503);
        computers.assertInstance(bot, instance);
        assertBound(bot, true);
        const browser = computers.browserFor(bot);
        if (url.search) throw new Fault('INVALID_REQUEST', 400);
        if (request.method === 'GET' && !action) {
          const view = await browser.view(bot);
          computers.assertInstance(bot, instance);
          if (viewers.instance(request.headers['x-prototype-token'], bot) !== instance)
            throw new Fault('UNAUTHORIZED', 403);
          const { owner, epoch } = computers.control.state(bot);
          if (view.epoch !== epoch) throw new Fault('STALE_CONTROL');
          send(response, { lease: { owner, epoch }, view });
          return;
        }
        if (request.method !== 'POST' || action !== '/input')
          throw new Fault('METHOD_NOT_ALLOWED', 405);
        const input = browserInput(await body(request));
        computers.assertInstance(bot, instance);
        await browser.boundInput(bot, input.epoch, input.binding, input.input);
        send(response, { ok: true });
        return;
      }
      if (url.pathname !== '/exec' || url.search) throw new Fault('NOT_FOUND', 404);
      if (request.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
      if (!authority.accepts(request.headers['x-daban-execution-token']))
        throw new Fault('UNAUTHORIZED', 403);
      if (!ready) throw new Fault('EXECUTION_STARTING', 503);
      const value = await body(request);
      if (validAgentId(value.id)) id = value.id;
      if (!isExecutionRequest(value)) throw new Fault('EXECUTION_INVALID_REQUEST', 400);
      if (
        (value.boot !== undefined && value.boot !== boot) ||
        (value.nonce !== undefined && value.nonce !== nonce)
      )
        throw new Fault('EXECUTION_GUEST_RESTARTED');
      const result = await call(value, abort.signal);
      send(response, { role: 'executor', version: 1, id, boot, ok: true, value: result ?? null });
    } catch (error) {
      if (!response.headersSent)
        send(
          response,
          {
            role: 'executor',
            version: 1,
            id,
            boot,
            ok: false,
            error: errorCode(error) || 'EXECUTION_FAILED',
          },
          error instanceof Fault ? error.status : 500,
        );
      else response.end();
    }
  });
  await new Promise<unknown>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 8766, '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Fault('EXECUTION_LISTENER_FAILED');
  origin = `http://127.0.0.1:${address.port}`;
  try {
    await authority.publish();
    await processes.ready;
    machine = new Machine({
      dir: desktopDir,
      profileDir,
      origin,
      viewers,
      displayBase: 11,
      fullGuest: true,
    });
    computers = new Computers({
      file: path.join(directory, 'computers.sqlite'),
      limit: options.limit ?? 2,
      boot,
      driver: machine,
      registered: async (bot) => validAgentId(bot),
      admit: validAgentId,
      busy: (bot) =>
        [...runs.values()].some(
          (value) =>
            value.run.bot === bot &&
            [...value.operations.values()].some((operation) => operation.phase === 'running'),
        ),
      drain: async (bot) => {
        const current = [...runs.values()].filter((value) => value.run.bot === bot);
        await Promise.all(current.map(cancelRun));
        await Promise.all(
          current.map(async (value) => {
            await tools.drain(value.run);
            await Promise.allSettled(value.writes);
          }),
        );
      },
    });
    await computers.ready;
    tools = new AgentTools(computers.facade, workspace, { projects });
    if (tools.computer)
      tools.computer.authorize = async (run) => {
        if (run.project) projects.get(run.project, run.bot);
      };
    tools.shellRunner = async (run, command) => {
      // Concurrent calls keep their own durable process identity across service replacement.
      const id = operationContext.getStore();
      if (!id) throw new Fault('EXECUTION_OPERATION_UNKNOWN');
      await processes.start({ id, command, cwd: run.workdir });
      if (run.id) runs.get(run.id)?.processes.add(id);
      return processes.wait(id, run.abort.signal);
    };
    ready = true;
  } catch (error) {
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    await processes.close();
    throw error;
  }
  function bindProject(bot: string, scope?: ProjectScope) {
    // A connecting screen must never combine its old HOME with a newly selected profile.
    try {
      computers.assertStable(bot);
    } catch {
      throw new Fault('PROJECT_BUSY');
    }
    if (scope) projects.get(scope, bot);
    const key = scope ? `${scope.projectId}:${scope.revision}` : 'legacy-shared';
    if (machine.binding(bot) === key) return { bot, ...(scope ? { scope } : {}) };
    if (
      computers.available(bot) ||
      [...runs.values()].some((value) => value.run.bot === bot && !value.closing)
    )
      throw new Fault('PROJECT_BUSY');
    if (scope) {
      const resources = projects.get(scope, bot);
      const grant = resources.project.grants.find((item) => item.bot === bot)!;
      machine.bind(bot, {
        key,
        workspace: projects.files({ scope, resourceId: resources.files, bot }),
        ...(grant.browser ? { profile: projects.profile(scope, bot) } : {}),
      });
      bindings.set(bot, structuredClone(scope));
    } else {
      machine.bind(bot);
      bindings.delete(bot);
    }
    return { bot, ...(scope ? { scope } : {}) };
  }
  function assertBound(bot: string, browser = false) {
    const scope = bindings.get(bot);
    if (scope) projects.get(scope, bot, browser ? 'browser' : 'read');
  }
  async function scoped(params: Record<string, unknown>) {
    if (isProjectFileScope(params.project)) {
      if (Array.isArray(params.parts)) {
        const reference = params.project;
        if (
          JSON.stringify(params.parts) !==
          JSON.stringify(['model-runs', reference.runId, reference.bot])
        )
          throw new Fault('PROJECT_ACCESS_DENIED', 403);
        return new WorkspaceFiles(projects.runs(reference), projects.runs(reference));
      }
      return projects.workspace(params.project, params.root, params.canonical);
    }
    if (params.root === undefined) {
      if (params.canonical !== undefined && params.canonical !== (await workspace.base()))
        throw new Fault('WORKSPACE_MOVED');
      return workspace;
    }
    const base = await workspace.base();
    const root = String(params.root);
    if (root !== base && !root.startsWith(base + path.sep))
      throw new Fault('EXECUTION_WORKSPACE_SCOPE', 400);
    const result = new WorkspaceFiles(
      root,
      params.canonical === undefined ? undefined : String(params.canonical),
    );
    const actual = await result.base();
    if (actual !== base && !actual.startsWith(base + path.sep))
      throw new Fault('EXECUTION_WORKSPACE_SCOPE', 400);
    return result;
  }
  function runFor(id: unknown) {
    const value = typeof id === 'string' ? runs.get(id) : undefined;
    if (!value) throw new Fault('EXECUTION_RUN_UNKNOWN');
    return value;
  }
  async function retired(id: string) {
    try {
      const handle = await open(
        path.join(closedDirectory, `${id}.closed`),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size !== 0 ||
          info.uid !== process.getuid?.() ||
          (info.mode & 0o777) !== 0o600
        )
          throw new Fault('EXECUTION_RUN_STORE_FAILED');
        return true;
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw new Fault('EXECUTION_RUN_STORE_FAILED');
    }
  }
  async function retire(id: string) {
    if (await retired(id)) return;
    const handle = await open(
      path.join(closedDirectory, `${id}.closed`),
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    const parent = await open(
      closedDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await syncDirectory(parent);
    } finally {
      await parent.close();
    }
  }
  function runStatus(value: GuestRun, operationId?: string) {
    const operation = operationId ? value.operations.get(operationId) : undefined;
    return {
      id: operationId || value.run.id,
      phase: operation ? operation.phase : operationId ? 'unknown' : 'running',
      waitingForComputer: !!value.run.waitingForComputer,
      toolCount: value.run.toolCount,
      executedCount: value.run.trace.filter((trace) => trace.phase === 'settled').length,
      trace: value.run.trace.map(({ name, surface, at, phase, code }) => ({
        name,
        surface,
        at,
        phase,
        ...(code ? { code } : {}),
      })),
      ...(operation?.result ? { result: operation.result } : {}),
    };
  }
  function catalog(run: AgentToolRun) {
    return [
      ...tools.list(run.bot, run.model, undefined, run).map((tool) =>
        tool.name === 'shell'
          ? {
              ...tool,
              description:
                'Execute a Bash command in the Linux guest with full guest filesystem/network access and passwordless sudo. The actual task directory is cwd; use relative output paths or the actual path from the request. /workspace and /shared are file-tool aliases, not mounts for this command. This tool waits for completion; use process_start for long-running or interactive work. Host files, keys and trusted controls are outside this guest.',
            }
          : tool,
      ),
      ...processToolList,
    ];
  }
  async function cancelRun(value: GuestRun) {
    value.closing = true;
    value.run.abort.abort();
    await Promise.allSettled(
      [...value.processes].map((id) => processes.cancel({ id, requestId: value.run.id! })),
    );
  }
  async function processTool(
    value: GuestRun,
    operationId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const run = value.run;
    const trace = {
      name,
      surface: 'process',
      at: new Date().toISOString(),
      phase: 'running' as 'running' | 'settled' | 'rejected',
      code: undefined as string | undefined,
    };
    run.trace.push(trace);
    try {
      run.abort.signal.throwIfAborted();
      if (++run.toolCount > run.limit) throw new Fault('TOOL_LIMIT');
      const fields =
        name === 'process_start'
          ? ['command']
          : name === 'process_input'
            ? ['id', 'data', 'eof']
            : ['id'];
      if (!executionKeys(args, fields)) throw new Fault('INVALID_TOOL_ARGS', 400);
      let result: ProcessSnapshot;
      if (name === 'process_start') {
        result = await processes.start({
          id: operationId,
          command: args.command as string,
          cwd: run.workdir,
        });
        value.processes.add(result.id);
        if (run.abort.signal.aborted) await processes.cancel({ id: result.id, requestId: run.id! });
      } else if (name === 'process_poll') result = await processes.poll(args.id as string);
      else if (name === 'process_input')
        result = await processes.input({
          id: args.id as string,
          requestId: operationId,
          data: args.data as string,
          ...(args.eof === undefined ? {} : { eof: args.eof as boolean }),
        });
      else if (name === 'process_cancel')
        result = await processes.cancel({ id: args.id as string, requestId: operationId });
      else throw new Fault('INVALID_TOOL_ARGS', 400);
      trace.phase = 'settled';
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      trace.phase = 'rejected';
      trace.code = errorCode(error) || 'PROCESS_FAILED';
      return { isError: true, content: [{ type: 'text', text: trace.code }] };
    }
  }
  function handleFor(id: unknown) {
    const handle = typeof id === 'string' ? handles.get(id) : undefined;
    if (!handle || handle.closing) throw new Fault('EXECUTION_HANDLE_CLOSED');
    return handle;
  }
  function enqueue<T>(handle: Handle, action: () => Promise<T>) {
    const operation = handle.queue.then(action);
    handle.queue = operation.catch(() => {});
    return operation;
  }
  async function call(request: ExecutionRequest, signal: AbortSignal): Promise<unknown> {
    const { method, params } = request;
    const projectBound =
      (method === 'tools.open' && params.project !== undefined) ||
      method.startsWith('projects.') ||
      isProjectFileScope(params.project) ||
      !!handles.get(String(params.handleId))?.project ||
      !!runs.get(String(params.runId))?.run.project;
    if (projectBound && (request.boot !== boot || request.nonce !== nonce))
      throw new Fault('EXECUTION_GUEST_RESTARTED');
    if (method === 'projects.sync') return projects.sync(params);
    if (method === 'projects.bind')
      return bindProject(String(params.bot), params.scope as ProjectScope | undefined);
    if (method === 'computer.snapshot') {
      const raw = await computers.snapshot();
      const result: ExecutionSnapshot = {
        role: 'executor',
        version: 1,
        boot,
        nonce,
        capabilities: [
          ...executionCapabilities,
          modelExecutionCapability,
          skillPackageCapability,
          browserTaskCapability,
          ...(projects.available() ? [projectCapability] : []),
        ],
        computer: {
          mode: raw.mode,
          bots: raw.bots,
          browsers: raw.browsers,
          sharedLogin: raw.sharedLogin,
          viewport: raw.viewport,
          environment: raw.environment,
          events: [],
        },
        status: computers.status(),
      };
      return result;
    }
    if (method === 'computer.status') return computers.status();
    if (method === 'computer.request')
      return computerRequest(
        String(params.method),
        String(params.path),
        executionRecord(params.body) ? params.body : {},
      );
    if (method === 'documents.extract') {
      if (!isDocumentUpload(params)) throw new Fault('INVALID_DOCUMENT', 400);
      return documents.extract(params, signal);
    }
    if (method.startsWith('workspace.')) {
      if (method === 'workspace.close') {
        const handle = handles.get(String(params.handleId));
        if (!handle) return { ok: true };
        handle.closing = true;
        handle.abort.abort();
        await handle.queue;
        await handle.directory.close();
        handles.delete(String(params.handleId));
        return { ok: true };
      }
      if (method === 'workspace.verify' || method === 'workspace.write') {
        const handle = handleFor(params.handleId);
        return enqueue(handle, async () => {
          const combined = AbortSignal.any([signal, handle.abort.signal]);
          combined.throwIfAborted();
          if (handle.project) projects.get(handle.project.scope, handle.project.bot);
          if (method === 'workspace.verify') await handle.directory.verify();
          else
            await handle.directory.write(
              String(params.name),
              Buffer.from(String(params.data), 'base64'),
              combined,
            );
          return { ok: true };
        });
      }
      const files = await scoped(params);
      if (method === 'workspace.base') return files.base();
      if (method === 'workspace.list') return files.list();
      if (method === 'workspace.read')
        return files.read(
          String(params.path),
          params.limit === undefined ? undefined : Number(params.limit),
        );
      if (method === 'workspace.download') return files.download(String(params.path));
      if (method === 'workspace.skill') {
        if (!isSkillPackage(params.package)) throw new Fault('INVALID_SKILL_PACKAGE', 400);
        return files.stageSkill(params.package, signal);
      }
      if (method === 'workspace.create') {
        if (handles.size >= 256) throw new Fault('EXECUTION_HANDLE_LIMIT');
        const task = await files.create(params.parts as string[]);
        const handleId = randomUUID();
        handles.set(handleId, {
          directory: task,
          ...(isProjectFileScope(params.project) ? { project: params.project } : {}),
          queue: Promise.resolve(),
          abort: new AbortController(),
          closing: false,
        });
        return { root: task.root, path: task.path, canonical: task.canonical, handleId };
      }
    }
    if (method === 'tools.open') {
      const description = stable(params);
      const previous = runs.get(String(params.id));
      if (previous) {
        if (previous.closing) throw new Fault('EXECUTION_RUN_CLOSED');
        if (previous.description !== description) throw new Fault('EXECUTION_RUN_CONFLICT');
        return { ...runStatus(previous), tools: catalog(previous.run) };
      }
      const id = String(params.id),
        pending = opening.get(id);
      if (pending) {
        if (pending.description !== description) throw new Fault('EXECUTION_RUN_CONFLICT');
        return pending.promise;
      }
      if (runs.size + opening.size >= 256) throw new Fault('EXECUTION_RUN_LIMIT');
      const promise = (async () => {
        if (await retired(id)) throw new Fault('EXECUTION_RUN_CLOSED');
        const fields = params as unknown as ExecutionRun;
        bindProject(fields.bot, fields.project);
        const base = fields.project
          ? projects.workdir(projects.reference(fields.project, fields.bot, fields.id))
          : await workspace.base();
        const canonical = await new WorkspaceFiles(fields.workdir, fields.canonicalRoot).base();
        if (fields.project ? canonical !== base : !canonical.startsWith(base + path.sep))
          throw new Fault('EXECUTION_WORKSPACE_SCOPE');
        const run: AgentToolRun = {
          ...fields,
          ...(fields.prompt ? { task: { requestId: fields.id, prompt: fields.prompt } } : {}),
          abort: new AbortController(),
          toolCount: 0,
          seen: {},
          trace: [],
        };
        const value: GuestRun = {
          description,
          run,
          operations: new Map(),
          writes: new Set(),
          processes: new Set(),
          closing: false,
        };
        runs.set(fields.id, value);
        return { ...runStatus(value), tools: catalog(run) };
      })();
      opening.set(id, { description, promise });
      try {
        return await promise;
      } finally {
        opening.delete(id);
      }
    }
    if (method === 'tools.poll' && !runs.has(String(params.runId)))
      return {
        id: params.operationId,
        phase: 'unknown',
        waitingForComputer: false,
        toolCount: 0,
        executedCount: 0,
        trace: [],
      };
    if (method.startsWith('tools.')) {
      if (
        method === 'tools.drain' &&
        !runs.has(String(params.runId)) &&
        (await retired(String(params.runId)))
      )
        return { ok: true };
      const value = runFor(params.runId);
      if (value.closing && (method === 'tools.write' || method === 'tools.invoke'))
        throw new Fault('EXECUTION_RUN_CLOSED');
      if (method === 'tools.write') {
        const cancel = () => value.run.abort.abort();
        signal.addEventListener('abort', cancel, { once: true });
        const write = tools.writeText(
          value.run,
          params.path,
          params.content,
          Boolean(params.createOnly),
        );
        value.writes.add(write);
        try {
          return await write;
        } finally {
          value.writes.delete(write);
          signal.removeEventListener('abort', cancel);
        }
      }
      if (method === 'tools.cancel') {
        await cancelRun(value);
        return runStatus(value);
      }
      if (method === 'tools.drain') {
        value.draining ||= (async () => {
          value.closing = true;
          await tools.drain(value.run);
          await Promise.allSettled(
            [...value.operations.values()].map((operation) => operation.done),
          );
          await Promise.allSettled(value.writes);
          const status = runStatus(value);
          // An empty durable marker retires the id without retaining historical runs in RAM.
          await retire(String(params.runId));
          runs.delete(String(params.runId));
          return status;
        })();
        return value.draining;
      }
      const operationId = String(params.operationId);
      if (method === 'tools.poll') return runStatus(value, operationId);
      if (method === 'tools.invoke') {
        const digest = stable({ name: params.name, args: params.args, wireId: params.wireId });
        const previous = value.operations.get(operationId);
        if (previous) {
          if (previous.digest !== digest) throw new Fault('EXECUTION_OPERATION_CONFLICT');
          return runStatus(value, operationId);
        }
        if (value.operations.size >= 1000) throw new Fault('EXECUTION_OPERATION_LIMIT');
        const operation: Operation = { digest, phase: 'running', done: Promise.resolve() };
        value.operations.set(operationId, operation);
        const pending = operationContext.run(operationId, () =>
          processToolList.some((tool) => tool.name === params.name)
            ? processTool(
                value,
                operationId,
                String(params.name),
                params.args as Record<string, unknown>,
              )
            : tools.invoke(
                value.run,
                String(params.name),
                params.args as Record<string, unknown>,
                params.wireId as string | undefined,
              ),
        );
        operation.done = pending
          .then((result) => {
            operation.result = result;
            operation.phase = 'settled';
          })
          .catch((error) => {
            operation.result = {
              isError: true,
              content: [{ type: 'text', text: errorCode(error) || 'EXECUTION_TOOL_FAILED' }],
            };
            operation.phase = 'settled';
          });
        return runStatus(value, operationId);
      }
    }
    if (method === 'process.start')
      return processes.start(params as unknown as { id: string; command: string; cwd: string });
    if (method === 'process.poll') return processes.poll(String(params.id));
    if (method === 'process.input')
      return processes.input(
        params as unknown as { id: string; requestId: string; data: string; eof?: boolean },
      );
    if (method === 'process.cancel')
      return processes.cancel(params as unknown as { id: string; requestId: string });
    throw new Fault('EXECUTION_INVALID_REQUEST', 400);
  }
  async function computerRequest(method: string, target: string, data: Record<string, unknown>) {
    if (!target.startsWith('/') || target.startsWith('//'))
      throw new Fault('EXECUTION_INVALID_ROUTE', 400);
    const url = new URL(target, origin);
    const bound = url.pathname.match(/^\/api\/bots\/([a-zA-Z0-9_-]{1,80})\/(.+)$/);
    if (
      bound &&
      !(
        (bound[2] === 'input' && executionRecord(data.input) && data.input.type === 'release') ||
        (bound[2] === 'control' && data.owner === 'agent')
      )
    )
      assertBound(bound[1], bound[2].startsWith('browser'));

    if (
      method === 'POST' &&
      !url.search &&
      url.pathname === '/api/computers/action' &&
      isComputerRequest(data)
    )
      return computers.operate(data);
    if (
      method === 'POST' &&
      !url.search &&
      url.pathname === '/api/computers/receipt' &&
      executionKeys(data, ['id', 'bot']) &&
      validAgentId(data.id) &&
      validAgentId(data.bot)
    )
      return computers.receipt(data.id, data.bot);
    const match = url.pathname.match(
      /^\/api\/bots\/([a-zA-Z0-9_-]{1,80})\/(control|input|app|frame|browser-frame|browser-state|browser-view|browser-command|browser-answer|browser-receipt|browser-bound-input|browser-input)$/,
    );
    if (!match) throw new Fault('EXECUTION_INVALID_ROUTE', 400);
    const [, bot, action] = match;
    if (method === 'GET' && ['frame', 'browser-frame'].includes(action)) {
      const instance = url.searchParams.get('instance');
      const rawEpoch = url.searchParams.get('epoch');
      if (
        url.searchParams.size !== 2 ||
        [...url.searchParams.keys()].some((key) => !['instance', 'epoch'].includes(key)) ||
        !validAgentId(instance) ||
        !/^(0|[1-9]\d*)$/.test(rawEpoch || '') ||
        !Number.isSafeInteger(Number(rawEpoch))
      )
        throw new Fault('INVALID_REQUEST', 400);
      const epoch = Number(rawEpoch);
      computers.assertInstance(bot, instance);
      if (computers.control.state(bot).epoch !== epoch) throw new Fault('STALE_CONTROL');
      const image =
        action === 'frame'
          ? await computers.frame(bot, instance, epoch)
          : await computers.browserFrame(bot);
      computers.assertInstance(bot, instance);
      if (computers.control.state(bot).epoch !== epoch) throw new Fault('STALE_CONTROL');
      return { mimeType: 'image/jpeg', data: image.toString('base64') };
    }
    if (url.search) throw new Fault('EXECUTION_INVALID_ROUTE', 400);
    if (action.startsWith('browser-')) {
      const browser = computers.browserFor(bot);
      const tabs = browser.tabs;
      if (!tabs) throw new Fault('BROWSER_UNAVAILABLE', 503);
      if (method === 'GET' && action === 'browser-state') return tabs.state(bot);
      if (method === 'GET' && action === 'browser-view') return browser.view(bot);
      if (method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
      if (action === 'browser-command' && isBrowserCommandRequest(data))
        return tabs.human(bot, data);
      if (action === 'browser-answer' && isBrowserAnswerRequest(data))
        return tabs.answer(bot, data);
      if (action === 'browser-receipt' && executionKeys(data, ['id']) && validAgentId(data.id))
        return tabs.receipt(bot, data.id);
      if (action === 'browser-bound-input' || action === 'browser-input') {
        const input = browserInput(data);
        await browser.boundInput(bot, input.epoch, input.binding, input.input);
        return { ok: true };
      }
      throw new Fault('INVALID_BROWSER_REQUEST', 400);
    }
    if (
      method !== 'POST' ||
      !validAgentId(data.instance) ||
      !Number.isSafeInteger(data.epoch) ||
      Number(data.epoch) < 0
    )
      throw new Fault('INVALID_REQUEST', 400);
    const epoch = Number(data.epoch);
    computers.assertInstance(bot, data.instance);
    if (
      action === 'control' &&
      executionKeys(data, ['epoch', 'owner', 'instance']) &&
      ['human', 'agent'].includes(String(data.owner))
    )
      return computers.transfer(bot, epoch, String(data.owner), data.instance);
    if (action === 'input' && executionKeys(data, ['epoch', 'input', 'instance'])) {
      await computers.input(bot, epoch, data.input, data.instance);
      return { ok: true };
    }
    if (
      action === 'app' &&
      executionKeys(data, ['epoch', 'app', 'instance']) &&
      ['terminal', 'files', 'editor', 'browser'].includes(String(data.app))
    ) {
      await computers.openApp(bot, epoch, String(data.app), data.instance);
      return { ok: true };
    }
    throw new Fault('EXECUTION_INVALID_ROUTE', 400);
  }
  let closing: Promise<unknown> | undefined;
  async function shutdown() {
    ready = false;
    await Promise.all([...runs.values()].map(cancelRun));
    await Promise.allSettled(
      [...runs.values()].map(async (value) => {
        await tools.drain(value.run);
        await Promise.allSettled([...value.operations.values()].map((operation) => operation.done));
        await Promise.allSettled(value.writes);
      }),
    );
    await Promise.allSettled(
      [...handles.values()].map(async (handle) => {
        handle.abort.abort();
        await handle.queue;
        await handle.directory.close();
      }),
    );
    await documents.close();
    await processes.close();
    await computers.close();
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
  }
  return {
    origin,
    close: () => {
      closing ||= shutdown();
      return closing;
    },
  };
}
