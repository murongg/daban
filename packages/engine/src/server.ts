import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { arch, platform, release } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  appDirectoryProtocol,
  type BotProfile,
  botBundleLimit,
  chatAssistantProtocol,
  type ExecutionSnapshot,
  type Group,
  type GroupPage,
  isAppCommand,
  isAttachmentId,
  isAttachmentQuery,
  isAttachmentUpload,
  isAttachmentVersion,
  isBotCopyRequest,
  isBotExportRequest,
  isBotImportHeader,
  isBotLifecycleRequest,
  isBrowserAnswerRequest,
  isBrowserBinding,
  isBrowserCommandRequest,
  isBrowserInput,
  isChatRequest,
  isComputerRequest,
  isConversationRequest,
  isDocumentUpload,
  isExecutionSnapshot,
  isGroupCopyRequest,
  isHostBrowserRequest,
  isKnowledgeContent,
  isKnowledgeWrite,
  isLegacyWorkQuery,
  isLegacyWorkWrite,
  isMcpCommand,
  isMemoryQuery,
  isNoteCommand,
  isRebootStatus,
  isRecoveryRequest,
  isSearchCheckRequest,
  isSearchReceiptQuery,
  isSearchUpdate,
  isSetupStatus,
  isSkillBinding,
  isSkillContent,
  isSkillPackage,
  isSkillPath,
  isTaskFileName,
  isTaskInsert,
  isTranscriptContentQuery,
  isTranscriptQuery,
  isUserReply,
  isWorkCommentQuery,
  isWorkCommentWrite,
  isWorkQuery,
  isWorkWrite,
  legacyWorkItem,
  legacyWorkList,
  legacyWorkReceipt,
  managedProtocol,
  mcpAppsView,
  parseBotJSON,
  type RebootStatus,
  type RuntimeCommand,
  type RuntimeNoticeStatus,
  type SetupStatus,
  validAgentId,
} from '@daban/protocol';
import { Authority, ViewerGrants } from './authority.js';
import { Commands, type HostCommandExecutor } from './commands.js';
import { Computers } from './computers.js';
import { errorCode, Fault } from './control.js';
import { createDesktop, Desktop, type DesktopOptions } from './desktop.js';
import { Diagnostics, desktopDependencies } from './diagnostics.js';
import { Documents } from './documents.js';
import type { Executor } from './execution.js';
import { Folders } from './folders.js';
import { folderRequest } from './folders-api.js';
import { GroupTools } from './group-tools.js';
import { Groups } from './groups.js';
import { HostBrowser } from './host-browser.js';
import { appCommand, integrationCommand } from './integration-api.js';
import { jinaEnabled, jinaSettingFile, setJinaEnabled } from './jina.js';
import { BotLifecycle } from './lifecycle.js';
import { LinuxTools } from './linux-tools.js';
import { LocalCodex } from './local-codex.js';
import { LocalCommandTools } from './local-command-tools.js';
import { LocalTools } from './local-tools.js';
import { Machine } from './machine.js';
import { ModelRuns } from './model.js';
import { NativeWorkspace } from './native-workspace.js';
import { privateServer } from './private-channel.js';
import { Recovery } from './recovery.js';
import { RemoteWorkspace, type WorkspaceExecutor } from './remote-workspace.js';
import { Risk } from './risk.js';
import { type Browser, createBrowser } from './runtime.js';
import { nativeSchedules } from './schedule-domain.js';
import { ScheduleTools } from './schedule-tools.js';
import { Schedules } from './schedules.js';
import { SearchSettings } from './search-settings.js';
import { ModelSettings } from './settings.js';
import { skillHash, writeSkillZip } from './skill-package.js';
import { type SoftwareBackend, SoftwareClient } from './software.js';
import { UpgradeGate } from './upgrade.js';
import { type AgentWorkspace, WorkspaceFiles } from './workspace.js';

const root = path.dirname(fileURLToPath(import.meta.url));
function legacyGroup(group: Group): Group {
  const { id, name, members, revision, createdAt, updatedAt } = group;
  return { id, name, members, revision, createdAt, updatedAt };
}
function groupReply(value: Group | GroupPage, modern: boolean) {
  if (modern) return value;
  return 'group' in value ? { ...value, group: legacyGroup(value.group) } : legacyGroup(value);
}
async function groupStatus(groups: Groups | undefined, modern: boolean) {
  const status = groups ? await groups.status() : { available: false, revision: 0, items: [] };
  return modern
    ? status
    : { ...status, items: status.items.filter((group) => !group.archived).map(legacyGroup) };
}

function clientProfile(profile: BotProfile, protocol: number) {
  if (protocol >= chatAssistantProtocol || !profile.assistant) return profile;
  // Older clients validate profile keys strictly when reading the status snapshot.
  const { assistant: _assistant, ...legacy } = profile;
  return legacy;
}

async function chatStatus(models: ModelRuns, conversationAware: boolean, trashAware: boolean) {
  const status = await models.chats.status();
  if (!status.available) return status;
  const { lifecycle = [], ...legacy } = status;
  const trashed = new Set(
    lifecycle.filter((item) => item.trashed).map((item) => `${item.bot}:${item.revision}`),
  );
  return {
    ...legacy,
    ...(conversationAware
      ? {
          conversations: models.journal
            .conversations()
            .filter((item) => !trashed.has(`${item.bot}:${item.revision}`)),
        }
      : {}),
    ...(trashAware ? { lifecycle } : {}),
  };
}
async function noticeStatus(
  models: ModelRuns | undefined,
  groups: Groups | undefined,
): Promise<RuntimeNoticeStatus> {
  const items = models?.journal.notices() || [];
  try {
    return {
      available: !!models && !!groups,
      items: [...items, ...(groups ? await groups.notices() : [])],
    };
  } catch {
    return { available: false, items, error: 'GROUP_NOTICES_UNAVAILABLE' };
  }
}
// Only exact local readers bypass recovery. External probes, writes and executions remain fenced.
const recoveryReads = new Set([
  '/api/model/saved',
  '/api/notes/status',
  '/api/notes/list',
  '/api/notes/read',
  '/api/notes/receipt',
  '/api/work/list',
  '/api/work/read',
  '/api/work/receipt',
  '/api/work/comments',
  '/api/work/comment-receipt',
  '/api/computers/receipt',
  '/api/files/read',
  '/api/files/download',
  '/api/groups/read',
  '/api/groups/input',
  '/api/groups/action-receipt',
  '/api/chats/receipt',
  '/api/chats/action-receipt',
  '/api/chats/history',
  '/api/transcripts/statistics',
  '/api/transcripts/list',
  '/api/transcripts/content',
  '/api/memory/history',
  '/api/attachments/list',
  '/api/attachments/read',
  '/api/attachments/source',
  '/api/knowledge/list',
  '/api/knowledge/read',
  '/api/knowledge/source',
  '/api/knowledge/versions',
  '/api/skills/list',
  '/api/skills/read',
  '/api/skills/resource',
  '/api/skills/export-package',
  '/api/bundles/export',
  '/api/bundles/cancel',
  '/api/schedules/get',
  '/api/schedules/preview',
  '/api/mcp/list',
  '/api/mcp/saved',
  '/api/mcp/catalog',
  '/api/mcp/bindings',
  '/api/mcp/calls',
  '/api/mcp/receipt',
  '/api/search/saved',
]);

async function body(
  req: IncomingMessage,
  limit = 8 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json'))
    throw new Fault('JSON_REQUIRED', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Fault('BODY_TOO_LARGE', 413);
    chunks.push(chunk);
  }
  try {
    const bytes = Buffer.concat(chunks);
    const value: unknown =
      limit > 8 * 1024 * 1024
        ? parseBotJSON(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        : JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('object required');
    return value as Record<string, unknown>;
  } catch {
    throw new Fault('INVALID_JSON', 400);
  }
}

function boundInput(data: Record<string, unknown>) {
  if (
    Object.keys(data).some((key) => !['epoch', 'binding', 'input'].includes(key)) ||
    !Number.isSafeInteger(data.epoch) ||
    Number(data.epoch) < 0 ||
    !isBrowserBinding(data.binding) ||
    !isBrowserInput(data.input)
  )
    throw new Fault('INVALID_INPUT', 400);
  return { epoch: Number(data.epoch), binding: data.binding, input: data.input };
}

export interface Prototype<
  R extends Browser | Desktop | Computers = Browser | Desktop | Computers,
> {
  url: string;
  token: string;
  runtime: R;
  models?: ModelRuns;
  schedules?: Schedules;
  groups?: Groups;
  lifecycle?: BotLifecycle;
  recovery?: Recovery;
  executionRecovery?: Recovery;
  refreshExecution?: () => Promise<ExecutionSnapshot>;
  close: () => Promise<unknown>;
}
export interface PrototypeOptions {
  host?: HostComposition;
  software?: SoftwareBackend;
  computers?: true | { dir?: string; displayBase?: number; limit?: number };
  profileDir?: string;
  port?: number;
  interval?: number;
  fixture?: boolean;
  desktop?: boolean | Partial<Pick<DesktopOptions, 'dir' | 'displayBase'>>;
}
export interface HostComposition {
  onUpdate?: () => unknown;
  environment?: {
    readonly busy: boolean;
    status(): Promise<SetupStatus>;
    start(mode?: import('@daban/protocol').QemuMode): Promise<SetupStatus>;
    cancel(): Promise<SetupStatus>;
    enable?(): Promise<SetupStatus>;
  };
  localComputer?: import('./local-computer.js').LocalComputerClient;
  nativeWorkspace?: string;
  runLocalCommand?: HostCommandExecutor;
  offlineWorkspaceRoot?: string;
  identity?: {
    dataRoot: string;
    socketPath: string;
    entry?: string;
    executable?: string;
  };
  reboot?: {
    status: () => RebootStatus | Promise<RebootStatus>;
    invoke: (command: RuntimeCommand) => Promise<unknown>;
  };
  dataRoot: string;
  socketPath: string;
  scope: string;
  execution?: Pick<Executor, 'ready' | 'snapshot' | 'refresh'> &
    WorkspaceExecutor & { available?(): Promise<boolean> };
  sdkFile: string;
  stdioEntry?: string;
}
export function startPrototype(
  options: PrototypeOptions & {
    computers: true | { dir?: string; displayBase?: number; limit?: number };
  },
): Promise<Prototype<Computers>>;
export function startPrototype(
  options: PrototypeOptions & {
    desktop: true | Partial<Pick<DesktopOptions, 'dir' | 'displayBase'>>;
  },
): Promise<Prototype<Desktop>>;
export function startPrototype(
  options?: PrototypeOptions & { desktop?: false },
): Promise<Prototype<Browser>>;
export function startPrototype(options: PrototypeOptions): Promise<Prototype>;
export async function startPrototype({
  software,
  profileDir,
  port = 8766,
  interval,
  desktop = false,
  fixture = false,
  computers,
  host,
}: PrototypeOptions = {}): Promise<Prototype> {
  if (host && !host.execution && !host.nativeWorkspace) throw new Fault('AGENT_REMOTE_REQUIRED');
  if (computers && desktop) throw new Fault('INVALID_COMPUTER_CONFIG', 400);
  profileDir ||= host
    ? path.join(host.dataRoot, 'browser', 'profile')
    : path.resolve(root, '../../work/browser/profile');
  const modelDir = host ? path.join(host.dataRoot, 'model') : path.resolve(profileDir, '../model');
  const hostBrowser = host
    ? new HostBrowser({ directory: path.join(host.dataRoot, 'browser') })
    : undefined;
  if (host && (computers || desktop)) throw new Fault('AGENT_REMOTE_REQUIRED');
  await mkdir(host ? modelDir : profileDir, { recursive: true, mode: 0o700 });
  const settings = new ModelSettings(
    path.join(modelDir, 'credentials.json'),
    fetch,
    process.platform === 'darwin' && host?.nativeWorkspace ? new LocalCodex() : undefined,
  );
  const searches = new SearchSettings(path.join(modelDir, 'search.json'), settings);
  const jinaFile = path.join(modelDir, jinaSettingFile);
  // Search configuration is optional; its status endpoint reports corruption without blocking ordinary Host startup.
  await searches.status().catch(() => undefined);
  const authority = new Authority(path.join(modelDir, 'control-token'));
  const appAuthority = host ? new Authority(path.join(modelDir, 'app-control-token')) : undefined;
  const token = authority.token;
  const viewers = new ViewerGrants();
  const assets = new Map();
  for (const name of host
    ? []
    : [
        'index.html',
        'style.css',
        'app.js',
        'fixture.html',
        'fixture.css',
        'fixture.js',
        'managed.html',
      ])
    assets.set(name, await readFile(path.join(root, name)));
  let runtime: Browser | Desktop | Computers | undefined;
  let models: ModelRuns | undefined;
  let schedules: Schedules | undefined;
  let groups: Groups | undefined;
  let lifecycle: BotLifecycle | undefined;
  let recovery: Recovery | undefined;
  let linuxRecovery: Recovery | undefined;
  let linuxAvailable = false;
  let commands: Commands | undefined;
  let localCommands: Commands | undefined;
  let files: AgentWorkspace | undefined;
  let executionSnapshot: ExecutionSnapshot | undefined;
  let computerAvailable = !host?.nativeWorkspace && !host?.offlineWorkspaceRoot;
  let replacingRecovery = false;
  const upgrade = new UpgradeGate();
  let refreshingExecution: Promise<ExecutionSnapshot> | undefined;
  const changing = new Set<string>();
  function createHostRecovery(snapshot: ExecutionSnapshot) {
    return new Recovery({
      file: path.join(modelDir, 'recovery.json'),
      boot: snapshot.boot,
      instance: `agent-${randomBytes(18).toString('base64url')}`,
      quiesce: async () => {
        await Promise.all([groups?.drain(), schedules?.drain()]);
      },
      snapshot: () => ({
        computersRevision: executionSnapshot!.status.revision,
        screens: executionSnapshot!.status.items
          .filter((row) => row.reserved)
          .map((computer) => {
            const lease = executionSnapshot!.computer.bots[computer.bot];
            return {
              computer,
              ...(lease ? { lease: { owner: lease.owner, epoch: lease.epoch } } : {}),
            };
          }),
        running: [...(models?.jobs.values() || [])]
          .filter((job) => models!.running(job.bot))
          .map((job) => job.bot),
        changing:
          changing.size > 0 ||
          replacingRecovery ||
          !!models?.bundles.busy ||
          executionSnapshot!.status.items.some((row) =>
            ['connecting', 'stopping'].includes(row.phase),
          ),
      }),
    });
  }
  function refreshExecution(): Promise<ExecutionSnapshot> {
    if (!host?.execution) throw new Fault('AGENT_REMOTE_REQUIRED');
    if (refreshingExecution) return refreshingExecution;
    refreshingExecution = (async () => {
      const snapshot = await host.execution!.refresh();
      if (!isExecutionSnapshot(snapshot)) throw new Fault('EXECUTION_INVALID_RESPONSE');
      const previous = executionSnapshot;
      if (previous && (snapshot.boot !== previous.boot || snapshot.nonce !== previous.nonce)) {
        replacingRecovery = true;
        try {
          await Promise.allSettled(
            [...(models?.jobs.values() || [])]
              .filter(
                (job) =>
                  models!.running(job.bot) &&
                  (!host?.nativeWorkspace || models!.tools.linux?.restarted(job, snapshot)),
              )
              .map((job) => models!.stop(job.bot, 'execution-restarted')),
          );
          executionSnapshot = snapshot;
          if (snapshot.boot !== previous.boot) {
            if (host.nativeWorkspace) {
              await linuxRecovery?.close();
              linuxRecovery = createHostRecovery(snapshot);
              await linuxRecovery.ready;
            } else {
              await recovery?.close();
              recovery = createHostRecovery(snapshot);
              await recovery.ready;
            }
          }
        } finally {
          replacingRecovery = false;
        }
      } else executionSnapshot = snapshot;
      if (host.nativeWorkspace && !linuxRecovery) {
        linuxRecovery = createHostRecovery(snapshot);
        await linuxRecovery.ready;
      }
      if (host.offlineWorkspaceRoot) {
        const root = await host.execution!.call('workspace.base', {});
        if (root !== host.offlineWorkspaceRoot) throw new Fault('WORKSPACE_CHANGED');
      }
      computerAvailable = true;
      if (models?.tools.linux) models.tools.linux.online = true;
      return snapshot;
    })()
      .catch((error) => {
        computerAvailable = false;
        if (models?.tools.linux) models.tools.linux.online = false;
        throw error;
      })
      .finally(() => {
        refreshingExecution = undefined;
      });
    return refreshingExecution;
  }
  async function remoteComputerSnapshot() {
    try {
      await refreshExecution();
      computerAvailable = true;
    } catch {
      computerAvailable = false;
    }
    if (host?.nativeWorkspace && !computerAvailable) return nativeSnapshot();
    if (!executionSnapshot) throw new Fault('EXECUTION_UNAVAILABLE');
    const { computer } = executionSnapshot;
    const { mode, sharedLogin, viewport, environment, bots, browsers } = computer;
    return {
      mode,
      sharedLogin,
      viewport,
      environment,
      bots,
      ...(browsers ? { browsers } : {}),
      events: [],
      ...(!computerAvailable ? { computerError: 'COMPUTER_START_FAILED' } : {}),
    };
  }
  function nativeSnapshot() {
    return {
      mode: 'agent' as const,
      sharedLogin: false,
      viewport: { width: 1280, height: 800 },
      environment: {
        platform: platform(),
        arch: arch(),
        kernel: release(),
        node: process.version,
        browser: '',
      },
      events: [],
      bots: {},
    };
  }
  async function optionalLinux() {
    if (!host?.nativeWorkspace) return;
    linuxAvailable = (await host.execution?.available?.()) ?? false;
    if (models?.tools.linux) models.tools.linux.enabled = linuxAvailable;
  }
  async function hostRebootStatus() {
    const status = await host!.reboot!.status();
    if (!isRebootStatus(status)) throw new Fault('INVALID_RECOVERY_STATE');
    return status;
  }
  let ready = false;
  const diagnostics = new Diagnostics({
    agent: () => ({ state: ready ? 'ready' : 'unavailable' }),
    dsh: () => ({ state: models?.status().available ? 'ready' : 'unavailable' }),
    model: async () => ({ state: (await settings.status()).configured ? 'ready' : 'unconfigured' }),
    profiles: async () => {
      const status = await models!.profiles.status();
      return status.corrupt ? { state: 'degraded', affected: status.corrupt } : { state: 'ready' };
    },
    knowledge: async () => ({
      state: (await models!.knowledge.status()).available ? 'ready' : 'unavailable',
    }),
    attachments: async () => ({
      state: (await models!.attachments.status()).available ? 'ready' : 'unavailable',
    }),
    interactions: async () => {
      const status = await models!.interactions.status();
      return status.corrupt ? { state: 'degraded', affected: status.corrupt } : { state: 'ready' };
    },
    schedules: async () => ({
      state: (await schedules!.status()).available ? 'ready' : 'unavailable',
    }),
    groups: async () => ({ state: (await groups!.status()).available ? 'ready' : 'unavailable' }),
    skills: async () => ({
      state: (await models!.skills.status()).available ? 'ready' : 'unavailable',
    }),
    mcp: async () => ({
      state: (await models!.integrations.status()).available ? 'ready' : 'unavailable',
    }),
    computers: () => {
      if (!host && !(runtime instanceof Computers)) return { state: 'unsupported' };
      if (host?.nativeWorkspace && !linuxAvailable) return { state: 'unsupported' };
      const status = host ? executionSnapshot?.status : (runtime as Computers).status();
      if (!status?.available || (host && !computerAvailable)) return { state: 'unavailable' };
      const affected = status.items.filter((row) =>
        ['failed', 'interrupted'].includes(row.phase),
      ).length;
      return affected ? { state: 'degraded', affected } : { state: 'ready' };
    },
    graphics: host
      ? async () => ({ state: executionSnapshot && computerAvailable ? 'ready' : 'unavailable' })
      : desktopDependencies,
  });
  const documentAbort = new AbortController();
  const documents = host?.execution
    ? {
        async extract(file: Parameters<Documents['extract']>[0], signal?: AbortSignal) {
          const value = await host.execution!.call(
            'documents.extract',
            { ...file },
            AbortSignal.any([documentAbort.signal, ...(signal ? [signal] : [])]),
          );
          if (!isKnowledgeContent(value)) throw new Fault('DOCUMENT_UNREADABLE');
          return value;
        },
        async close() {
          documentAbort.abort();
        },
      }
    : new Documents();
  let origin = host ? 'http://127.0.0.1:8766' : '';
  const reply = (
    res: ServerResponse,
    status: number,
    type: string,
    data: string | Buffer | undefined,
  ) => {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    });
    res.end(data);
  };
  const json = (res: ServerResponse, data: unknown, status = 200) =>
    reply(res, status, 'application/json; charset=utf-8', JSON.stringify(data));
  const channel = await privateServer(
    async (req, res) => {
      let releaseMutation: (() => unknown) | undefined;
      let releaseUpdate: (() => unknown) | undefined;
      try {
        if (req.headers.host !== new URL(origin).host) throw new Fault('INVALID_HOST', 403);
        if (req.method !== 'GET' && req.headers.origin && req.headers.origin !== origin)
          throw new Fault('FOREIGN_ORIGIN', 403);
        const url = new URL(req.url || '/', origin);
        if (
          host?.nativeWorkspace &&
          !host.execution &&
          (/^\/api\/(computers|browser|native|worker|control)(?:\/|$)/.test(url.pathname) ||
            /^\/api\/(frame|app)$/.test(url.pathname))
        )
          throw new Fault('LOCAL_VM_UNAVAILABLE', 503);
        if (host && url.pathname === '/agent/identity' && req.method === 'GET' && !url.search)
          return json(res, {
            role: 'agent',
            scope: host.scope,
            dataRoot: host.identity?.dataRoot || host.dataRoot,
            socketPath: host.identity?.socketPath || host.socketPath,
            ...(host.identity?.entry ? { entry: host.identity.entry } : {}),
            ...(host.identity?.executable ? { executable: host.identity.executable } : {}),
          });
        if (host && url.pathname === '/api/host/update') {
          if (!authority.accepts(req.headers['x-prototype-token']))
            throw new Fault('UNAUTHORIZED', 403);
          if (req.method !== 'POST' || url.search) throw new Fault('INVALID_UPDATE_REQUEST', 400);
          if (!ready || !host.onUpdate) throw new Fault('AGENT_UPDATE_UNAVAILABLE', 503);
          const request = await body(req);
          if (Object.keys(request).length !== 1 || request.scope !== host.scope)
            throw new Fault('INVALID_UPDATE_REQUEST', 400);
          upgrade.prepare(
            () =>
              replacingRecovery ||
              !(recovery?.admit() ?? true) ||
              !(linuxRecovery?.admit() ?? true) ||
              changing.size > 0 ||
              !!models?.bundles.busy ||
              !!host.environment?.busy ||
              [...(models?.jobs.values() ?? [])].some((job) => models!.running(job.bot)),
          );
          // Respond before the CLI drains its HTTP listener. The VM is not part of this handoff.
          res.once('finish', () => {
            Promise.resolve()
              .then(() => host.onUpdate!())
              .catch(() => {
                upgrade.cancel();
                console.error('Agent update handoff failed');
              });
          });
          return json(res, { scope: host.scope, pid: process.pid });
        }
        if (host) releaseUpdate = upgrade.enter();
        if (host && url.pathname === '/api/host/environment') {
          if (!authority.accepts(req.headers['x-prototype-token']))
            throw new Fault('UNAUTHORIZED', 403);
          if (req.method !== 'POST' || url.search) throw new Fault('INVALID_SETUP_REQUEST', 400);
          if (!ready || !host.environment) throw new Fault('SETUP_UNAVAILABLE', 503);
          const request = await body(req),
            action = request.action,
            mode = request.mode;
          const fields =
            action === 'enable'
              ? ['scope', 'action', 'confirmed']
              : action === 'start'
                ? ['scope', 'action', 'mode']
                : ['scope', 'action'];
          if (
            Object.keys(request).some((key) => !fields.includes(key)) ||
            request.scope !== host.scope ||
            !['status', 'start', 'cancel', 'enable'].includes(String(action)) ||
            (action === 'enable' && request.confirmed !== true) ||
            (mode !== undefined && mode !== 'whpx' && mode !== 'tcg')
          )
            throw new Fault('INVALID_SETUP_REQUEST', 400);
          if (mode !== undefined && !(await host.environment.status()).windows)
            throw new Fault('INVALID_SETUP_REQUEST', 400);
          if (action === 'enable' && !host.environment.enable)
            throw new Fault('SETUP_UNAVAILABLE', 503);
          const value =
            action === 'enable'
              ? await host.environment.enable!()
              : action === 'start'
                ? await host.environment.start(mode)
                : action === 'cancel'
                  ? await host.environment.cancel()
                  : await host.environment.status();
          if (!isSetupStatus(value)) throw new Fault('SETUP_STORE', 500);
          return json(res, value);
        }
        const groupProtocol = req.headers['x-daban-client-protocol'];
        const groupVersion =
          typeof groupProtocol === 'string' && /^[1-9]\d*$/.test(groupProtocol)
            ? Number(groupProtocol)
            : 0;
        // Archive-aware group shapes start at28; current supported versions must not fall back to legacy.
        const modernGroups =
          Number.isSafeInteger(groupVersion) &&
          groupVersion >= 28 &&
          groupVersion <= managedProtocol;
        const coordinatedWork = groupVersion >= 39 && groupVersion <= managedProtocol;
        const conversationAware = groupVersion >= 46 && groupVersion <= managedProtocol;
        const trashAware = groupVersion >= 47 && groupVersion <= managedProtocol;
        const mcp = url.pathname.match(/^\/mcp\/([a-zA-Z0-9_-]{1,80})$/);
        if (mcp) {
          if (recovery && !recovery.admit()) throw new Fault('RUNTIME_RECOVERY_PENDING');
          if (!models) throw new Fault('STARTING', 503);
          if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
          const result = await models.rpc(mcp[1], req.headers.authorization, await body(req));
          if (result === null) {
            res.writeHead(202);
            res.end();
            return;
          }
          return json(res, result);
        }
        const viewer = url.pathname.match(/^\/viewer\/([a-zA-Z0-9_-]{1,80})(\/input)?$/);
        if (viewer) {
          const [, bot, action] = viewer;
          const instance = viewers.instance(req.headers['x-prototype-token'], bot);
          if (!instance) throw new Fault('UNAUTHORIZED', 403);
          if (!ready) throw new Fault('STARTING', 503);
          if (!(runtime instanceof Computers) && !(runtime instanceof Desktop))
            throw new Fault('COMPUTER_NOT_CONNECTED', 503);
          runtime.assertInstance(bot, instance);
          const browser = runtime instanceof Computers ? runtime.browserFor(bot) : runtime.browser;
          if (req.method === 'GET' && !action) {
            const view = await browser.view(bot);
            if (viewers.instance(req.headers['x-prototype-token'], bot) !== instance)
              throw new Fault('UNAUTHORIZED', 403);
            runtime.assertInstance(bot, instance);
            const { owner, epoch } = runtime.control.state(bot);
            if (view.epoch !== epoch) throw new Fault('STALE_CONTROL');
            return json(res, { lease: { owner, epoch }, view });
          }
          if (req.method !== 'POST' || action !== '/input')
            throw new Fault('METHOD_NOT_ALLOWED', 405);
          if (recovery) releaseMutation = recovery.enter();
          const input = boundInput(await body(req));
          if (viewers.instance(req.headers['x-prototype-token'], bot) !== instance)
            throw new Fault('UNAUTHORIZED', 403);
          runtime.assertInstance(bot, instance);
          await browser.boundInput(bot, input.epoch, input.binding, input.input);
          return json(res, { ok: true });
        }
        if (url.pathname.startsWith('/api/')) {
          if (!authority.accepts(req.headers['x-prototype-token']))
            throw new Fault('UNAUTHORIZED', 403);
          if (!ready) throw new Fault('STARTING', 503);
          if (host && url.pathname === '/api/host/recovery') {
            if (!host.reboot) throw new Fault('RECOVERY_UNAVAILABLE', 503);
            if (req.method !== 'POST' || url.search)
              throw new Fault('INVALID_RECOVERY_REQUEST', 400);
            const command = await body(req);
            const type = command.type;
            const valid = ['recovery.status', 'recovery.review'].includes(String(type))
              ? Object.keys(command).every((key) => key === 'type')
              : type === 'recovery.restart'
                ? Object.keys(command).every((key) => ['type', 'request'].includes(key)) &&
                  isRecoveryRequest(command.request)
                : ['recovery.inspect', 'recovery.cancel', 'recovery.start'].includes(
                    String(type),
                  ) &&
                  Object.keys(command).every((key) => ['type', 'id'].includes(key)) &&
                  validAgentId(command.id);
            if (!valid) throw new Fault('INVALID_RECOVERY_REQUEST', 400);
            return json(res, await host.reboot.invoke(command as unknown as RuntimeCommand));
          }
          if (url.pathname === '/api/recovery' || url.pathname === '/api/recovery/review') {
            if (!recovery) throw new Fault('RECOVERY_UNAVAILABLE', 503);
            if (req.method !== 'GET') throw new Fault('METHOD_NOT_ALLOWED', 405);
            if (url.search) throw new Fault('INVALID_RECOVERY_REQUEST', 400);
            if (host && url.pathname.endsWith('/review')) await refreshExecution();
            return json(
              res,
              url.pathname.endsWith('/review') ? recovery.review() : recovery.status(),
            );
          }
          if (url.pathname.startsWith('/api/recovery/')) {
            if (!recovery) throw new Fault('RECOVERY_UNAVAILABLE', 503);
            if (req.method !== 'POST' || url.search)
              throw new Fault('INVALID_RECOVERY_REQUEST', 400);
            const data = await body(req);
            if (host && url.pathname === '/api/recovery/prepare') await refreshExecution();
            if (url.pathname === '/api/recovery/prepare')
              return json(res, await recovery.prepare(data));
            if (
              !validAgentId(data.id) ||
              Object.keys(data).some((key) => !['id', 'revision'].includes(key))
            )
              throw new Fault('INVALID_RECOVERY_REQUEST', 400);
            if (url.pathname === '/api/recovery/receipt' && Object.keys(data).length === 1)
              return json(res, recovery.receipt(data.id));
            if (!Number.isSafeInteger(data.revision) || Number(data.revision) < 0)
              throw new Fault('INVALID_RECOVERY_REQUEST', 400);
            if (url.pathname === '/api/recovery/claim')
              return json(res, await recovery.claim(data.id, Number(data.revision)));
            if (url.pathname === '/api/recovery/cancel')
              return json(res, await recovery.cancel(data.id, Number(data.revision)));
            throw new Fault('INVALID_RECOVERY_REQUEST', 400);
          }
          const directoryRoute = url.pathname === '/api/mcp/apps';
          if (directoryRoute && req.method === 'GET') {
            if (url.search) throw new Fault('OAUTH_INVALID_REQUEST', 400);
            return json(res, { protocol: appDirectoryProtocol });
          }
          const appRoute = url.pathname === '/api/mcp/app' || directoryRoute;
          const appInput = appRoute ? await body(req, 32000) : undefined;
          if (appInput) {
            if (!models) throw new Fault('MCP_STORE_UNAVAILABLE', 503);
            if (req.method !== 'POST' || url.search || !isAppCommand(appInput))
              throw new Fault('OAUTH_INVALID_REQUEST', 400);
            if (directoryRoute !== ['app.directory', 'app.oauth.connect'].includes(appInput.type))
              throw new Fault('OAUTH_INVALID_REQUEST', 400);
            // Local reads and revocation cannot launch a task or bypass the recovery fence for a new authorization.
            if (appInput.type !== 'app.oauth.start' && appInput.type !== 'app.oauth.connect')
              return json(
                res,
                await appCommand(
                  models,
                  appInput,
                  appAuthority?.accepts(req.headers['x-daban-app-control'])
                    ? 'interactive'
                    : 'service',
                  !!host,
                ),
              );
          }
          if (
            recovery &&
            req.method !== 'GET' &&
            url.pathname !== '/api/host-browser' &&
            !recoveryReads.has(url.pathname) &&
            !/^\/api\/bots\/[a-zA-Z0-9_-]{1,80}\/(browser-receipt|lifecycle-receipt|copy-receipt)$/.test(
              url.pathname,
            ) &&
            !/^\/api\/groups\/[a-zA-Z0-9_-]{1,80}\/copy-receipt$/.test(url.pathname)
          ) {
            const input = url.pathname.match(/^\/api\/bots\/([a-zA-Z0-9_-]{1,80})\/input$/);
            if (
              !recovery.admit() &&
              input &&
              req.method === 'POST' &&
              (host || runtime instanceof Computers)
            ) {
              const data = await body(req);
              // Releasing held keys/buttons reduces authority and must remain possible while recovery fences new input.
              if (
                Object.keys(data).every((key) => ['epoch', 'input', 'instance'].includes(key)) &&
                Number.isSafeInteger(data.epoch) &&
                validAgentId(data.instance) &&
                data.input &&
                typeof data.input === 'object' &&
                'type' in data.input &&
                data.input.type === 'release'
              ) {
                if (host)
                  await host.execution!.call('computer.request', {
                    method: 'POST',
                    path: url.pathname,
                    body: data,
                  });
                else
                  await (runtime as Computers).input(
                    input[1],
                    Number(data.epoch),
                    data.input,
                    data.instance,
                  );
                return json(res, { ok: true });
              }
              throw new Fault('RUNTIME_RECOVERY_PENDING');
            }
            releaseMutation = recovery.enter();
          }
          const remoteRoute = url.pathname.match(
            /^\/api\/bots\/([a-zA-Z0-9_-]{1,80})\/(frame|browser-frame|control|input|app|browser-state|browser-view|browser-command|browser-answer|browser-receipt|browser-bound-input|browser-input)$/,
          );
          if (url.pathname === '/api/host-browser') {
            if (!hostBrowser || !models) throw new Fault('HOST_BROWSER_UNAVAILABLE', 503);
            if (req.method !== 'POST' || url.search)
              throw new Fault('INVALID_BROWSER_REQUEST', 400);
            const request = await body(req);
            if (!isHostBrowserRequest(request)) throw new Fault('INVALID_BROWSER_REQUEST', 400);
            const autoStartRead = request.action === 'autoStart' && request.enabled === undefined;
            if (
              !autoStartRead &&
              !['state', 'view', 'receipt'].includes(request.action) &&
              !(request.action === 'input' && request.input.type === 'release')
            )
              releaseMutation = recovery?.enter();
            models.profiles.assertRegistered(request.bot);
            if (!['state', 'receipt'].includes(request.action))
              models.profiles.assertActive(request.bot);
            const changes =
              request.action === 'open' ||
              request.action === 'close' ||
              (request.action === 'autoStart' && !autoStartRead);
            if (changes) {
              if (models.running(request.bot)) throw new Fault('COMPUTER_BUSY');
              if (changing.has(request.bot)) throw new Fault('COMPUTER_CHANGING');
              changing.add(request.bot);
            }
            try {
              if (
                request.action === 'open' &&
                (await host?.localComputer?.status())?.session?.bot === request.bot
              )
                throw new Fault('LOCAL_COMPUTER_BUSY');
              if (changes) models.profiles.assertActive(request.bot);
              return json(res, await hostBrowser.request(request));
            } finally {
              if (changes) changing.delete(request.bot);
            }
          }
          if (
            host &&
            (remoteRoute ||
              ['/api/computers/action', '/api/computers/receipt'].includes(url.pathname))
          ) {
            const execution = host.execution;
            if (!execution || (host.nativeWorkspace && !linuxAvailable))
              throw new Fault('LOCAL_VM_UNAVAILABLE', 503);
            if (!models) throw new Fault('STARTING', 503);
            if (!['GET', 'POST'].includes(req.method || ''))
              throw new Fault('METHOD_NOT_ALLOWED', 405);
            const data = req.method === 'POST' ? await body(req) : undefined;
            const action = url.pathname === '/api/computers/action';
            let bot = remoteRoute?.[1];
            if (!remoteRoute) {
              if (req.method !== 'POST' || url.search || !data)
                throw new Fault('INVALID_COMPUTER_REQUEST', 400);
              if (
                action
                  ? !isComputerRequest(data)
                  : Object.keys(data).some((key) => !['id', 'bot'].includes(key)) ||
                    !validAgentId(data.id) ||
                    !validAgentId(data.bot)
              )
                throw new Fault('INVALID_COMPUTER_REQUEST', 400);
              bot = String(data.bot);
            }
            models.profiles.assertRegistered(bot!);
            if (action) {
              models.profiles.assertActive(bot!);
              if (models.running(bot!)) throw new Fault('COMPUTER_BUSY');
              if (changing.has(bot!)) throw new Fault('COMPUTER_CHANGING');
              changing.add(bot!);
            }
            try {
              if (action) {
                await models.drainComputer(bot!);
                models.profiles.assertActive(bot!);
              }
              const result = await execution.call('computer.request', {
                method: req.method,
                path: url.pathname + url.search,
                ...(data ? { body: data } : {}),
              });
              if (action) await refreshExecution();
              if (
                remoteRoute &&
                req.method === 'GET' &&
                ['frame', 'browser-frame'].includes(remoteRoute[2])
              ) {
                const frame = result as { mimeType?: unknown; data?: unknown };
                if (
                  frame?.mimeType !== 'image/jpeg' ||
                  typeof frame.data !== 'string' ||
                  frame.data.length > 12 * 1024 * 1024 ||
                  Buffer.from(frame.data, 'base64').toString('base64') !== frame.data
                )
                  throw new Fault('EXECUTION_INVALID_RESPONSE');
                return reply(res, 200, 'image/jpeg', Buffer.from(frame.data, 'base64'));
              }
              return json(res, result);
            } finally {
              if (action) changing.delete(bot!);
            }
          }
          if (url.pathname.startsWith('/api/folders/')) {
            if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
            if (url.search) throw new Fault('INVALID_LOCAL_FILE_ARGS', 400);
            const folders = models?.tools.localFiles?.folders;
            if (!folders || !models) throw new Fault('LOCAL_FOLDERS_UNAVAILABLE', 503);
            return json(
              res,
              await folderRequest(
                folders,
                models.profiles,
                url.pathname.slice('/api/folders/'.length),
                await body(req),
              ),
            );
          }
          if (url.pathname.startsWith('/api/notes/')) {
            if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
            if (url.search) throw new Fault('INVALID_NOTE_REQUEST', 400);
            if (!models) throw new Fault('NOTES_UNAVAILABLE', 503);
            const data = await body(req);
            const command = { ...data, type: `notes.${url.pathname.slice('/api/notes/'.length)}` };
            if (Object.hasOwn(data, 'type') || !isNoteCommand(command))
              throw new Fault('INVALID_NOTE_REQUEST', 400);
            if (!(await models.profiles.get(command.bot)))
              throw new Fault('BOT_PROFILE_NOT_FOUND', 404);
            if (command.type === 'notes.status')
              return json(res, {
                bot: command.bot,
                status: await models.notes.status(command.bot),
              });
            if (command.type === 'notes.list')
              return json(res, {
                bot: command.bot,
                query: command.query,
                page: await models.notes.list(command.bot, command.query),
              });
            if (command.type === 'notes.read')
              return json(res, await models.notes.get(command.bot, command.id));
            // This authenticated channel belongs to the Human; no client author or Bot impersonation is accepted.
            return json(
              res,
              command.type === 'notes.write'
                ? await models.notes.write(command.bot, command.request, { kind: 'human' })
                : await models.notes.receipt(command.bot, command.request, { kind: 'human' }),
            );
          }
          if (url.pathname.startsWith('/api/work/')) {
            if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
            if (url.search) throw new Fault('INVALID_WORK_REQUEST', 400);
            if (!models) throw new Fault('WORK_UNAVAILABLE', 503);
            const data = await body(req);
            if (url.pathname === '/api/work/comments' && isWorkCommentQuery(data))
              return json(res, { query: data, page: await models.work.comments(data) });
            if (isWorkCommentWrite(data)) {
              if (
                url.pathname === '/api/work/comment' ||
                url.pathname === '/api/work/comment-receipt'
              ) {
                const value =
                  url.pathname === '/api/work/comment'
                    ? await models.work.comment(data, { kind: 'human' })
                    : await models.work.commentReceipt(data, { kind: 'human' });
                return json(res, coordinatedWork ? value : legacyWorkReceipt(value));
              }
            }
            if (url.pathname === '/api/work/list' && isWorkQuery(data)) {
              if (!coordinatedWork && !isLegacyWorkQuery(data))
                throw new Fault('INVALID_WORK_QUERY', 400);
              const value = { query: data, page: await models.work.list(data) };
              return json(res, coordinatedWork ? value : legacyWorkList(value));
            }
            if (
              url.pathname === '/api/work/read' &&
              validAgentId(data.id) &&
              Object.keys(data).every((key) => key === 'id')
            ) {
              const value = await models.work.get(data.id);
              return json(res, coordinatedWork ? value : legacyWorkItem(value));
            }
            // Human provenance and compatibility are decided by the channel, never by payload fields.
            if (isWorkWrite(data)) {
              if (!coordinatedWork && !isLegacyWorkWrite(data))
                throw new Fault('INVALID_WORK_WRITE', 400);
              if (url.pathname === '/api/work/write') {
                const value = coordinatedWork
                  ? await models.work.write(data, { kind: 'human' })
                  : await models.work.writeLegacy(data, { kind: 'human' });
                return json(res, coordinatedWork ? value : legacyWorkReceipt(value));
              }
              if (url.pathname === '/api/work/receipt') {
                const value = await models.work.receipt(data, { kind: 'human' });
                return json(res, coordinatedWork ? value : legacyWorkReceipt(value));
              }
            }
            throw new Fault('INVALID_WORK_REQUEST', 400);
          }
          if (url.pathname.startsWith('/api/bundles/')) {
            if (!models) throw new Fault('STARTING', 503);
            if (url.search) throw new Fault('INVALID_BOT_BUNDLE', 400);
            const action = url.pathname.slice('/api/bundles/'.length);
            if (action.startsWith('status/') && req.method === 'GET') {
              const id = action.slice('status/'.length);
              if (!validAgentId(id)) throw new Fault('INVALID_BOT_IMPORT', 400);
              return json(res, await models.bundles.status(id));
            }
            if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
            if (action.startsWith('submit/')) {
              const id = action.slice('submit/'.length);
              if (!validAgentId(id)) throw new Fault('INVALID_BOT_IMPORT', 400);
              // Admission precedes the large body, so concurrent uploads cannot multiply JSON allocation.
              return json(
                res,
                await models.bundles.receive(id, () => body(req, botBundleLimit + 64 * 1024)),
              );
            }
            const data = await body(req);
            if (action === 'export' && isBotExportRequest(data))
              return json(res, await models.bundles.export(data));
            if ((action === 'begin' || action === 'cancel') && isBotImportHeader(data))
              return json(
                res,
                action === 'begin'
                  ? await models.bundles.begin(data)
                  : await models.bundles.cancel(data),
              );
            if (action === 'retry' && Object.keys(data).length === 1 && validAgentId(data.id))
              return json(res, await models.bundles.retry(data.id));
            throw new Fault('INVALID_BOT_BUNDLE', 400);
          }
          if (url.pathname === '/api/diagnostics') {
            if (req.method !== 'GET') throw new Fault('METHOD_NOT_ALLOWED', 405);
            if (url.search) throw new Fault('INVALID_DIAGNOSTIC_REQUEST', 400);
            return json(res, await diagnostics.inspect());
          }
          if ((url.pathname === '/api/mcp/app' || directoryRoute) && req.method === 'POST') {
            if (!models) throw new Fault('MCP_STORE_UNAVAILABLE', 503);
            const command = appInput;
            if (!isAppCommand(command) || url.search) throw new Fault('OAUTH_INVALID_REQUEST', 400);
            return json(
              res,
              await appCommand(
                models,
                command,
                appAuthority?.accepts(req.headers['x-daban-app-control'])
                  ? 'interactive'
                  : 'service',
                !!host,
              ),
            );
          }
          if (url.pathname.startsWith('/api/mcp/') && req.method === 'POST') {
            if (!models) throw new Fault('MCP_STORE_UNAVAILABLE', 503);
            const data = await body(req);
            if (
              !isMcpCommand(data) ||
              data.type !== `mcp.${url.pathname.slice('/api/mcp/'.length)}`
            )
              throw new Fault('INVALID_MCP_CONFIG', 400);
            // Both client generations send protocol28; this header selects metadata only, never OAuth authority.
            const mcpView = req.headers[mcpAppsView.header];
            if (mcpView !== undefined && mcpView !== mcpAppsView.value)
              throw new Fault('INVALID_MCP_VIEW', 400);
            const controller = new AbortController();
            const cancel = () => controller.abort();
            res.once('close', cancel);
            try {
              return json(
                res,
                await integrationCommand(
                  models,
                  data,
                  controller.signal,
                  appAuthority?.accepts(req.headers['x-daban-app-control'])
                    ? 'interactive'
                    : 'service',
                  mcpView === mcpAppsView.value ? 'apps' : 'bearer',
                ),
              );
            } finally {
              res.off('close', cancel);
            }
          }
          if (url.pathname.startsWith('/api/skills/') && req.method === 'POST') {
            if (!models) throw new Fault('SKILLS_UNAVAILABLE', 503);
            const data = await body(req),
              action = url.pathname.slice('/api/skills/'.length);
            const fields: Record<string, string[]> = {
              list: ['bot', 'includeDeleted'],
              read: ['bot', 'id'],
              import: ['bot', 'content'],
              'import-package': ['bot', 'package'],
              'update-package': ['bot', 'id', 'revision', 'package'],
              'export-package': ['bot', 'id', 'revision'],
              resource: ['bot', 'id', 'revision', 'path'],
              update: ['bot', 'id', 'revision', 'content'],
              recycle: ['bot', 'id', 'revision'],
              restore: ['bot', 'id', 'revision'],
              bind: ['bot', 'binding'],
              copy: ['bot', 'id', 'revision', 'targetBot'],
            };
            if (
              !fields[action] ||
              Object.keys(data).some((key) => !fields[action].includes(key)) ||
              !validAgentId(data.bot)
            )
              throw new Fault('INVALID_SKILL', 400);
            if (!(await models.profiles.get(data.bot))) throw new Fault('SKILL_BOT_NOT_FOUND', 404);
            if (action === 'import-package' && isSkillPackage(data.package)) {
              models.profiles.assertActive(data.bot);
              return json(res, await models.skills.importPackage(data.package, data.bot));
            }
            if (
              validAgentId(data.id) &&
              Number.isSafeInteger(data.revision) &&
              Number(data.revision) > 0
            ) {
              if (action === 'copy' && validAgentId(data.targetBot)) {
                models.profiles.assertActive(data.bot);
                if (!(await models.profiles.get(data.targetBot)))
                  throw new Fault('SKILL_BOT_NOT_FOUND', 404);
                models.profiles.assertActive(data.targetBot);
                return json(
                  res,
                  await models.skills.copy(
                    data.bot,
                    data.id,
                    Number(data.revision),
                    data.targetBot,
                  ),
                );
              }
              if (action === 'update-package' && isSkillPackage(data.package)) {
                models.profiles.assertActive(data.bot);
                return json(
                  res,
                  await models.skills.updatePackage(
                    data.id,
                    Number(data.revision),
                    data.package,
                    data.bot,
                  ),
                );
              }
              if (action === 'resource' && isSkillPath(data.path))
                return json(
                  res,
                  await models.skills.readResource(
                    data.id,
                    Number(data.revision),
                    data.path,
                    data.bot,
                  ),
                );
              if (action === 'export-package') {
                const bundle = await models.skills.exportPackage(
                    data.id,
                    Number(data.revision),
                    data.bot,
                  ),
                  bytes = writeSkillZip(bundle);
                return json(res, {
                  id: data.id,
                  revision: data.revision,
                  archive: {
                    name: `${bundle.root}.zip`,
                    size: bytes.length,
                    sha256: skillHash(bytes),
                    data: bytes.toString('base64'),
                  },
                });
              }
            }
            if (
              action === 'list' &&
              (data.includeDeleted === undefined || typeof data.includeDeleted === 'boolean')
            )
              return json(res, {
                bot: data.bot,
                catalog: await models.skills.list(
                  data.bot,
                  data.includeDeleted as boolean | undefined,
                ),
              });
            if (action === 'import' && isSkillContent(data.content))
              return json(res, await models.skills.import(data.content, data.bot));
            if (action === 'bind' && isSkillBinding(data.binding))
              return json(res, {
                bot: data.bot,
                entry: await models.skills.bind(data.bot, data.binding),
              });
            if (validAgentId(data.id)) {
              if (action === 'read') return json(res, await models.skills.read(data.id, data.bot));
              if (Number.isSafeInteger(data.revision) && Number(data.revision) > 0) {
                if (action === 'update' && isSkillContent(data.content))
                  return json(
                    res,
                    await models.skills.update(
                      data.id,
                      Number(data.revision),
                      data.content,
                      data.bot,
                    ),
                  );
                if (action === 'recycle')
                  return json(
                    res,
                    await models.skills.recycle(data.id, Number(data.revision), data.bot),
                  );
                if (action === 'restore')
                  return json(
                    res,
                    await models.skills.restore(data.id, Number(data.revision), data.bot),
                  );
              }
            }
            throw new Fault('INVALID_SKILL', 400);
          }
          if (url.pathname.startsWith('/api/computers/') && req.method === 'POST') {
            if (!(runtime instanceof Computers))
              throw new Fault('COMPUTER_SERVICE_UNAVAILABLE', 503);
            const data = await body(req);
            if (url.pathname === '/api/computers/action' && isComputerRequest(data))
              return json(res, await runtime.operate(data));
            if (
              url.pathname === '/api/computers/receipt' &&
              Object.keys(data).every((key) => ['id', 'bot'].includes(key)) &&
              validAgentId(data.id) &&
              validAgentId(data.bot)
            )
              return json(res, await runtime.receipt(data.id, data.bot));
            throw new Fault('INVALID_COMPUTER_REQUEST', 400);
          }
          if (url.pathname === '/api/memory/history' && req.method === 'POST') {
            if (!models) throw new Fault('MEMORY_UNAVAILABLE', 503);
            const data = await body(req);
            if (
              !Object.keys(data).every((key) => ['bot', 'query'].includes(key)) ||
              !validAgentId(data.bot) ||
              !isMemoryQuery(data.query)
            )
              throw new Fault('INVALID_MEMORY_QUERY', 400);
            return json(res, await models.profiles.history(data.bot, data.query));
          }
          if (url.pathname.startsWith('/api/transcripts/') && req.method === 'POST') {
            if (!models) throw new Fault('TRANSCRIPT_UNAVAILABLE', 503);
            const data = await body(req);
            if (url.pathname === '/api/transcripts/statistics' && isTranscriptQuery(data))
              return json(res, await models.statistics(data.scope));
            if (url.pathname === '/api/transcripts/list' && isTranscriptQuery(data))
              return json(res, await models.transcript(data.scope, data.after));
            if (url.pathname === '/api/transcripts/content' && isTranscriptContentQuery(data))
              return json(res, await models.transcriptContent(data.scope, data.seq, data.offset));
            throw new Fault('INVALID_TRANSCRIPT_QUERY', 400);
          }
          if (url.pathname.startsWith('/api/chats/') && req.method === 'POST') {
            if (!models) throw new Fault('CHAT_UNAVAILABLE', 503);
            const data = await body(req);
            if (
              url.pathname === '/api/chats/action' ||
              url.pathname === '/api/chats/action-receipt'
            ) {
              if (!isConversationRequest(data))
                throw new Fault('INVALID_CONVERSATION_REQUEST', 400);
              if (url.pathname === '/api/chats/action-receipt')
                return json(res, await models.chats.actionReceipt(data));
              if (!(await models.profiles.get(data.bot)))
                throw new Fault('BOT_PROFILE_NOT_FOUND', 404);
              return json(res, await models.chats.action(data));
            }
            if (url.pathname === '/api/chats/new') {
              if (!isChatRequest(data)) throw new Fault('INVALID_CHAT_REQUEST', 400);
              if (!(await models.profiles.get(data.bot)))
                throw new Fault('BOT_PROFILE_NOT_FOUND', 404);
              return json(res, await models.chats.renew(data));
            }
            if (!validAgentId(data.bot)) throw new Fault('INVALID_CHAT_REQUEST', 400);
            if (
              url.pathname === '/api/chats/receipt' &&
              validAgentId(data.id) &&
              Object.keys(data).every((key) => ['bot', 'id'].includes(key))
            )
              return json(res, await models.chats.receipt(data.bot, data.id));
            if (
              url.pathname === '/api/chats/history' &&
              Object.keys(data).every((key) =>
                ['bot', 'revision', 'before', 'runId', 'modelAccess'].includes(key),
              )
            ) {
              if (
                typeof data.revision !== 'number' ||
                (data.before !== undefined && typeof data.before !== 'string') ||
                (data.runId !== undefined && typeof data.runId !== 'string') ||
                (data.modelAccess !== undefined && data.modelAccess !== true)
              )
                throw new Fault('INVALID_CHAT_QUERY', 400);
              const page = await models.chatHistory(
                data.bot,
                data.revision,
                data.before,
                data.runId,
              );
              // Legacy readers reject unknown history fields; the accepted hint changes schema, never authorization.
              if (data.modelAccess !== true)
                page.items = page.items.map(
                  ({ attemptSummary: _attempts, rootRunId: _root, ...item }) => item,
                );
              return json(res, page);
            }
            throw new Fault('INVALID_CHAT_REQUEST', 400);
          }
          const groupCopy = url.pathname.match(
            /^\/api\/groups\/([a-zA-Z0-9_-]{1,80})\/(copy|copy-receipt)$/,
          );
          if (groupCopy) {
            if (!groups) throw new Fault('GROUP_UNAVAILABLE', 503);
            if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
            const data = await body(req);
            if (url.search || !isGroupCopyRequest(data) || data.group !== groupCopy[1])
              throw new Fault('INVALID_GROUP_COPY', 400);
            return json(
              res,
              groupCopy[2] === 'copy' ? await groups.copy(data) : await groups.copyReceipt(data),
            );
          }
          if (url.pathname.startsWith('/api/groups/') && req.method === 'POST') {
            if (!groups) throw new Fault('GROUP_UNAVAILABLE', 503);
            const data = await body(req),
              action = url.pathname.slice('/api/groups/'.length);
            if (action === 'register')
              return json(res, groupReply(await groups.register(data), modernGroups));
            if (action === 'send')
              return json(res, groupReply(await groups.send(data), modernGroups));
            if (action === 'action') return json(res, await groups.action(data));
            if (!validAgentId(data.group)) throw new Fault('INVALID_GROUP', 400);
            if (
              action === 'action-receipt' &&
              Object.keys(data).every((key) => ['group', 'id'].includes(key)) &&
              validAgentId(data.id)
            )
              return json(res, await groups.actionReceipt(data.group, data.id));
            if (
              action === 'input' &&
              Object.keys(data).every((key) => ['group', 'sourceId', 'name'].includes(key)) &&
              validAgentId(data.sourceId) &&
              isTaskFileName(data.name)
            )
              return json(res, {
                group: data.group,
                sourceId: data.sourceId,
                file: await groups.inputSource(data.group, data.sourceId, data.name),
              });
            if (
              action === 'read' &&
              Object.keys(data).every((key) => ['group', 'before'].includes(key))
            )
              return json(
                res,
                groupReply(
                  await groups.read(data.group, data.before as number | undefined),
                  modernGroups,
                ),
              );
            if (
              action === 'update' &&
              Object.keys(data).every((key) => ['group', 'revision', 'input'].includes(key)) &&
              typeof data.revision === 'number'
            )
              return json(
                res,
                groupReply(
                  await groups.update(data.group, data.revision, data.input),
                  modernGroups,
                ),
              );
            if (
              action === 'cancel' &&
              Object.keys(data).every((key) => ['group', 'sourceId'].includes(key)) &&
              validAgentId(data.sourceId)
            )
              return json(
                res,
                groupReply(await groups.cancel(data.group, data.sourceId), modernGroups),
              );
            throw new Fault('INVALID_GROUP', 400);
          }
          if (url.pathname.startsWith('/api/attachments/') && req.method === 'POST') {
            if (!models) throw new Fault('ATTACHMENT_UNAVAILABLE', 503);
            const data = await body(req),
              action = url.pathname.slice('/api/attachments/'.length);
            if (!validAgentId(data.bot)) throw new Fault('INVALID_ATTACHMENT', 400);
            if (
              action === 'list' &&
              Object.keys(data).every((key) => ['bot', 'query'].includes(key)) &&
              isAttachmentQuery(data.query)
            )
              return json(res, await models.attachments.list(data.bot, data.query));
            if (
              ['trash', 'restore', 'purge'].includes(action) &&
              isAttachmentId(data.id) &&
              isAttachmentVersion(data.version) &&
              Object.keys(data).every((key) =>
                ['bot', 'id', 'version', ...(action === 'purge' ? ['confirmation'] : [])].includes(
                  key,
                ),
              ) &&
              (action !== 'purge' || isTaskFileName(data.confirmation))
            )
              return json(
                res,
                await models.attachmentAction(data.bot, {
                  id: data.id,
                  version: data.version,
                  action: action as 'trash' | 'restore' | 'purge',
                  ...(action === 'purge' ? { confirmation: data.confirmation as string } : {}),
                }),
              );
            if (
              (action === 'source' || action === 'read') &&
              Object.keys(data).every((key) => ['bot', 'id'].includes(key)) &&
              isAttachmentId(data.id)
            )
              return json(
                res,
                action === 'source'
                  ? await models.attachments.source(data.bot, data.id)
                  : (await models.attachments.read(data.bot, data.id)).receipt,
              );
            if (
              action === 'upload' &&
              Object.keys(data).every((key) => ['bot', 'file'].includes(key)) &&
              isAttachmentUpload(data.file) &&
              isTaskFileName(data.file.name)
            ) {
              const abort = new AbortController();
              const disconnect = () => {
                if (!res.writableEnded) abort.abort();
              };
              res.once('close', disconnect);
              try {
                return json(
                  res,
                  await models.attachments.upload(
                    data.bot,
                    data.file,
                    (file, signal) => documents.extract(file, signal),
                    abort.signal,
                  ),
                );
              } finally {
                res.removeListener('close', disconnect);
              }
            }
            throw new Fault('INVALID_ATTACHMENT', 400);
          }
          if (url.pathname.startsWith('/api/knowledge/') && req.method === 'POST') {
            if (!models) throw new Fault('KNOWLEDGE_UNAVAILABLE', 503);
            const data = await body(req),
              action = url.pathname.slice('/api/knowledge/'.length),
              store = models.knowledge;
            if (!validAgentId(data.bot)) throw new Fault('INVALID_KNOWLEDGE', 400);
            const exact = (allowed: string[]) =>
              Object.keys(data).every((key) => allowed.includes(key));
            if (
              action === 'list' &&
              exact(['bot', 'query', 'includeDeleted']) &&
              (data.includeDeleted === undefined || typeof data.includeDeleted === 'boolean') &&
              (data.query === undefined ||
                (typeof data.query === 'string' &&
                  data.query.length <= 200 &&
                  !data.query.includes('\0')))
            ) {
              const files = await store.list(data.bot, data.includeDeleted === true);
              if (typeof data.query === 'string' && data.query.trim()) {
                const found = new Set(
                  (await store.search(data.bot, data.query, 100)).map((file) => file.id),
                );
                return json(
                  res,
                  files.filter(
                    (file) =>
                      found.has(file.id) ||
                      (file.deleted &&
                        file.path.toLowerCase().includes(String(data.query).toLowerCase())),
                  ),
                );
              }
              return json(res, files);
            }
            if (action === 'write' && exact(['bot', 'document']) && isKnowledgeWrite(data.document))
              return json(res, await store.write(data.bot, data.document));
            if (action === 'import' && exact(['bot', 'file']) && isDocumentUpload(data.file)) {
              const abort = new AbortController();
              const disconnect = () => {
                if (!res.writableEnded) abort.abort();
              };
              res.once('close', disconnect);
              try {
                const content = await documents.extract(data.file, abort.signal);
                abort.signal.throwIfAborted();
                return json(
                  res,
                  await store.importDocument(data.bot, data.file, content, abort.signal),
                );
              } finally {
                res.removeListener('close', disconnect);
              }
            }
            if (!validAgentId(data.id)) throw new Fault('INVALID_KNOWLEDGE', 400);
            if (action === 'source' && exact(['bot', 'id']))
              return json(res, await store.source(data.bot, data.id));
            if (
              action === 'read' &&
              exact(['bot', 'id', 'version']) &&
              (data.version === undefined || typeof data.version === 'number')
            )
              return json(res, await store.read(data.bot, data.id, data.version));
            if (
              action === 'versions' &&
              exact(['bot', 'id', 'before']) &&
              (data.before === undefined || typeof data.before === 'number')
            )
              return json(res, await store.versions(data.bot, data.id, data.before));
            if (
              action === 'remove' &&
              exact(['bot', 'id', 'revision']) &&
              typeof data.revision === 'number'
            )
              return json(res, await store.remove(data.bot, data.id, data.revision));
            if (
              action === 'restore' &&
              exact(['bot', 'id', 'revision', 'targetRevision']) &&
              typeof data.revision === 'number' &&
              typeof data.targetRevision === 'number'
            )
              return json(
                res,
                await store.restore(data.bot, data.id, data.revision, data.targetRevision),
              );
            throw new Fault('INVALID_KNOWLEDGE', 400);
          }
          if (url.pathname.startsWith('/api/schedules/') && req.method === 'POST') {
            if (!schedules) throw new Fault('SCHEDULE_UNAVAILABLE', 503);
            const data = await body(req);
            const action = url.pathname.slice('/api/schedules/'.length);
            if (action === 'create') return json(res, await schedules.create(data));
            if (action === 'preview' && Object.keys(data).every((key) => key === 'rule'))
              return json(res, await schedules.preview(data.rule));
            if (!validAgentId(data.id)) throw new Fault('INVALID_SCHEDULE', 400);
            if (action === 'get' && Object.keys(data).every((key) => key === 'id'))
              return json(res, await schedules.get(data.id));
            if (
              action === 'update' &&
              typeof data.revision === 'number' &&
              Object.keys(data).every((key) => ['id', 'revision', 'patch'].includes(key))
            )
              return json(res, await schedules.update(data.id, data.revision, data.patch));
            if (
              action === 'remove' &&
              typeof data.revision === 'number' &&
              Object.keys(data).every((key) => ['id', 'revision'].includes(key))
            )
              return json(res, await schedules.remove(data.id, data.revision));
            if (
              action === 'run' &&
              Object.keys(data).every((key) => ['id', 'requestId'].includes(key)) &&
              validAgentId(data.requestId)
            )
              return json(res, await schedules.run(data.id, data.requestId));
            throw new Fault('INVALID_SCHEDULE', 400);
          }
          if (
            [
              '/api/model/saved',
              '/api/model/fallback',
              '/api/model/remove',
              '/api/model/diagnose',
            ].includes(url.pathname)
          ) {
            if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
            if (url.search) throw new Fault('INVALID_MODEL_SETTINGS', 400);
          }
          if (url.pathname === '/api/web/jina') {
            if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
            const data = await body(req, 1024);
            if (url.search || Object.keys(data).length !== 1 || typeof data.enabled !== 'boolean')
              throw new Fault('INVALID_WEB_SETTINGS', 400);
            return json(res, await setJinaEnabled(jinaFile, data.enabled));
          }
          if (url.pathname.startsWith('/api/search/')) {
            if (url.search) throw new Fault('SEARCH_INVALID_SETTINGS', 400);
            const action = url.pathname.slice('/api/search/'.length);
            if (!['status', 'configure', 'check', 'saved'].includes(action))
              throw new Fault('NOT_FOUND', 404);
            if (req.method !== (action === 'status' ? 'GET' : 'POST'))
              throw new Fault('METHOD_NOT_ALLOWED', 405);
            if (action === 'status') {
              if (
                req.headers['transfer-encoding'] ||
                (req.headers['content-length'] && req.headers['content-length'] !== '0')
              )
                throw new Fault('SEARCH_INVALID_SETTINGS', 400);
              return json(res, await searches.status());
            }
            const data = await body(req, 16384);
            if (action === 'configure' && isSearchUpdate(data))
              return json(res, await searches.configure(data));
            if (action === 'check' && isSearchCheckRequest(data))
              // The Host owns a durably accepted check even if this requesting window or connection closes.
              return json(res, await searches.check(data));
            if (action === 'saved' && isSearchReceiptQuery(data))
              return json(res, await searches.saved(data));
            throw new Fault('SEARCH_INVALID_SETTINGS', 400);
          }
          if (url.pathname === '/api/model/settings') {
            if (req.method === 'GET')
              return json(res, await settings.status(url.searchParams.get('catalog') === '1'));
            if (req.method === 'POST') return json(res, await settings.save(await body(req)));
            throw new Fault('METHOD_NOT_ALLOWED', 405);
          }
          if (url.pathname === '/api/model/configure' && req.method === 'POST')
            return json(res, await settings.configure(await body(req)));
          if (url.pathname === '/api/model/saved' && req.method === 'POST')
            return json(res, await settings.saved(await body(req)));
          if (url.pathname === '/api/model/fallback' && req.method === 'POST')
            return json(res, await settings.fallback(await body(req)));
          if (url.pathname === '/api/model/remove' && req.method === 'POST') {
            if (!models) throw new Fault('STARTING', 503);
            await models.ready;
            return json(res, await settings.remove(await body(req)));
          }
          if (url.pathname === '/api/model/diagnose' && req.method === 'POST')
            return json(res, await settings.diagnose(await body(req)));
          if (url.pathname === '/api/model/inspect' && req.method === 'POST')
            return json(res, await settings.inspect(await body(req)));
          if (url.pathname === '/api/model/check' && req.method === 'POST') {
            const data = await body(req);
            if (
              typeof data.revision !== 'number' ||
              Object.keys(data).some((key) => key !== 'revision')
            )
              throw new Fault('INVALID_MODEL_SETTINGS', 400);
            return json(res, await settings.check(data.revision));
          }
          if (url.pathname === '/api/files' && req.method === 'GET' && files)
            return json(res, await files.list());
          if (
            ['/api/files/read', '/api/files/download'].includes(url.pathname) &&
            req.method === 'POST' &&
            files
          ) {
            const data = await body(req);
            if (typeof data.path !== 'string' || Object.keys(data).some((key) => key !== 'path'))
              throw new Fault('INVALID_FILE', 400);
            let source = files;
            if (host?.nativeWorkspace && models) {
              const root = await files.base();
              // History retains guest-relative links. An explicit read may wake Linux; listing native files never does.
              const guest = [...models.journal.records.values()].some(
                (record) =>
                  record.outputDirectory &&
                  !record.outputDirectory.startsWith(root + path.sep) &&
                  record.files?.some((file) => file.path === data.path),
              );
              if (guest) {
                if (!models.tools.linux?.enabled) throw new Fault('LOCAL_VM_UNAVAILABLE');
                source = models.tools.linux.workspace;
              }
            }
            return json(
              res,
              url.pathname.endsWith('/download')
                ? await source.download(data.path)
                : await source.read(data.path),
            );
          }
          if (url.pathname === '/api/bots') {
            if (!models) throw new Fault('STARTING', 503);
            if (req.method === 'GET')
              return json(
                res,
                (await models.profiles.list())
                  .filter((profile) => conversationAware || profile.kind !== 'chat')
                  .map((profile) => clientProfile(profile, groupVersion)),
              );
            if (req.method === 'POST')
              return json(
                res,
                clientProfile(await models.profiles.register(await body(req)), groupVersion),
              );
            throw new Fault('METHOD_NOT_ALLOWED', 405);
          }
          if (req.method === 'GET' && url.pathname === '/api/state') {
            await optionalLinux();
            return json(res, {
              ...(host?.execution
                ? await remoteComputerSnapshot()
                : runtime
                  ? await runtime.snapshot()
                  : {
                      mode: 'agent',
                      computerError: host?.nativeWorkspace ? undefined : 'COMPUTER_START_FAILED',
                      sharedLogin: false,
                      viewport: { width: 1280, height: 800 },
                      environment: {
                        platform: platform(),
                        arch: arch(),
                        kernel: release(),
                        node: process.version,
                        browser: '',
                      },
                      events: [],
                      bots: {},
                    }),
              botCapabilities: true,
              searchSettings: true,
              jinaReader: await jinaEnabled(jinaFile),
              clientProtocol: host || runtime instanceof Computers ? managedProtocol : 18,
              ...(host
                ? {
                    agent: {
                      location: 'host',
                      execution: host.nativeWorkspace ? 'local-workspace' : 'linux-vm',
                      privilege: host.nativeWorkspace ? 'workspace' : 'sudo',
                      approvals: 'host',
                    },
                  }
                : {}),
              ...(host?.localComputer ? { localComputer: await host.localComputer.status() } : {}),
              ...(models?.tools.localFiles ? { localFolders: true } : {}),
              ...(models?.tools.localCommands ? { hostCommandFullAccess: true } : {}),
              ...(host?.nativeWorkspace ? { computerAccess: true } : {}),
              ...(host?.nativeWorkspace ? { linux: { available: linuxAvailable } } : {}),
              ...(hostBrowser ? { hostBrowser: await hostBrowser.status() } : {}),
              ...(host?.reboot && (!host.nativeWorkspace || linuxAvailable)
                ? { reboot: await hostRebootStatus() }
                : {}),
              notices: await noticeStatus(models, groups),
              chats: models
                ? await chatStatus(models, conversationAware, trashAware)
                : { available: false, revision: 0, items: [], error: 'CHAT_UNAVAILABLE' },
              ...(recovery ? { recovery: recovery.status() } : {}),
              mcp: models
                ? await models.integrations.status()
                : { available: false, error: 'MCP_STORE_UNAVAILABLE' },
              appConnections: { catalog: true, oauthLoopback: !!host },
              appWorkspace: true,
              ...(models?.tools.software ? { software: await models.tools.software.status() } : {}),
              skills: models
                ? await models.skills.status()
                : { available: false, error: 'SKILLS_UNAVAILABLE' },
              ...(host
                ? {
                    computers:
                      host.nativeWorkspace && !computerAvailable
                        ? {
                            available: false,
                            revision: 0,
                            limit: 1,
                            items: [],
                            error: 'LOCAL_VM_UNAVAILABLE',
                          }
                        : computerAvailable
                          ? executionSnapshot!.status
                          : {
                              ...executionSnapshot!.status,
                              available: false,
                              error: 'COMPUTER_RUNTIME_UNAVAILABLE',
                            },
                  }
                : runtime instanceof Computers
                  ? { computers: runtime.status() }
                  : {}),
              groups: await groupStatus(groups, modernGroups),
              work: models
                ? await models.work.status()
                : { available: false, error: 'WORK_UNAVAILABLE' },
              notes: models
                ? await models.notes.availability()
                : { available: false, error: 'NOTES_UNAVAILABLE' },
              knowledge: models
                ? {
                    ...(await models.knowledge.status()),
                    documentParsing:
                      (host?.nativeWorkspace ? linuxAvailable : !!host?.execution) ||
                      platform() === 'linux',
                  }
                : { available: false, documentParsing: false },
              profiles: models
                ? (await models.profiles.list())
                    .filter((profile) => conversationAware || profile.kind !== 'chat')
                    .map((profile) => clientProfile(profile, groupVersion))
                : [],
              interactions: models ? await models.interactions.list() : [],
              schedules: schedules ? await schedules.status() : { available: false, items: [] },
              // Capability metadata stays outside saved-model status so older clients can still validate that status.
              model: { ...models?.status(), ...(await settings.status(true)), inspection: true },
            });
          }
          const browserRoute = url.pathname.match(
            /^\/api\/bots\/([a-zA-Z0-9_-]{1,80})\/browser-(state|view|command|answer|receipt|bound-input|input)$/,
          );
          if (browserRoute) {
            if (!runtime) throw new Fault('COMPUTER_NOT_CONNECTED', 503);
            const [, bot, action] = browserRoute;
            const browser =
              runtime instanceof Computers
                ? runtime.browserFor(bot)
                : 'browser' in runtime
                  ? runtime.browser
                  : runtime;
            const tabs = browser.tabs;
            if (!tabs) throw new Fault('BROWSER_UNAVAILABLE', 503);
            if (req.method === 'GET') {
              if (action === 'state') return json(res, await tabs.state(bot));
              if (action === 'view') return json(res, await browser.view(bot));
            }
            if (req.method !== 'POST' || ['state', 'view'].includes(action))
              throw new Fault('METHOD_NOT_ALLOWED', 405);
            const data = await body(req);
            if (action === 'answer') {
              if (!isBrowserAnswerRequest(data)) throw new Fault('INVALID_BROWSER_REQUEST', 400);
              return json(res, await tabs.answer(bot, data));
            }
            if (action === 'command') {
              if (!isBrowserCommandRequest(data)) throw new Fault('INVALID_BROWSER_REQUEST', 400);
              return json(res, await tabs.human(bot, data));
            }
            if (action === 'receipt') {
              if (Object.keys(data).some((key) => key !== 'id') || !validAgentId(data.id))
                throw new Fault('INVALID_BROWSER_REQUEST', 400);
              return json(res, await tabs.receipt(bot, data.id));
            }
            const input = boundInput(data);
            await browser.boundInput(bot, input.epoch, input.binding, input.input);
            return json(res, { ok: true });
          }
          const match = url.pathname.match(
            /^\/api\/bots\/([a-zA-Z0-9_-]{1,80})\/(control|worker|model|insert|profile|reply|input|frame|app|browser-frame|browser-input|lifecycle|lifecycle-receipt|copy|copy-receipt)$/,
          );
          if (!match) throw new Fault('NOT_FOUND', 404);
          const [, id, action] = match;
          if (
            [
              'model',
              'insert',
              'profile',
              'reply',
              'lifecycle',
              'lifecycle-receipt',
              'copy',
              'copy-receipt',
            ].includes(action)
          ) {
            if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
            const data = await body(req);
            if (action === 'copy' || action === 'copy-receipt') {
              if (!models) throw new Fault('STARTING', 503);
              if (url.search || !isBotCopyRequest(data) || data.bot !== id)
                throw new Fault('INVALID_BOT_COPY', 400);
              return json(
                res,
                action === 'copy'
                  ? await models.profiles.copy(data)
                  : await models.profiles.copyReceipt(data),
              );
            }
            if (action === 'lifecycle' || action === 'lifecycle-receipt') {
              if (!lifecycle) throw new Fault('BOT_LIFECYCLE_UNAVAILABLE', 503);
              if (action === 'lifecycle') {
                if (!isBotLifecycleRequest(data) || data.bot !== id)
                  throw new Fault('INVALID_BOT_LIFECYCLE', 400);
                return json(res, await lifecycle.operate(data));
              }
              if (Object.keys(data).some((key) => key !== 'id') || !validAgentId(data.id))
                throw new Fault('INVALID_BOT_LIFECYCLE', 400);
              return json(res, await lifecycle.receipt(id, data.id));
            }
            if (action === 'reply' && models) {
              if (
                Object.keys(data).some((key) => !['id', 'runId', 'reply'].includes(key)) ||
                !validAgentId(data.id) ||
                !validAgentId(data.runId) ||
                !isUserReply(data.reply)
              )
                throw new Fault('INVALID_INTERACTION_REPLY', 400);
              return json(
                res,
                await models.interactions.reply(id, data.runId, data.id, data.reply),
              );
            }
            if (action === 'profile' && models) {
              if (Object.keys(data).some((key) => !['revision', 'patch'].includes(key)))
                throw new Fault('INVALID_BOT_PROFILE', 400);
              return json(
                res,
                clientProfile(
                  await models.profiles.update(id, data.revision, data.patch),
                  groupVersion,
                ),
              );
            }
            if (action === 'model' && models && typeof data.running === 'boolean') {
              if ((host || runtime instanceof Computers) && data.running && data.task === undefined)
                throw new Fault('TASK_REQUIRED', 400);
              if (data.running) return json(res, await models.start(id, data.task));
              await models.stop(id);
              return json(res, { ok: true });
            }
            if (action === 'insert' && models) {
              if (!isTaskInsert(data)) throw new Fault('INVALID_TASK_INSERT', 400);
              return json(res, await models.insert(id, data));
            }
            throw new Fault('INVALID_REQUEST', 400);
          }
          if (!runtime) throw new Fault('COMPUTER_NOT_CONNECTED', 503);
          runtime.page(id);
          const native =
            runtime instanceof Desktop || runtime instanceof Computers ? runtime : undefined;
          if (native && req.method === 'GET' && ['frame', 'browser-frame'].includes(action)) {
            const instance = url.searchParams.get('instance'),
              rawEpoch = url.searchParams.get('epoch');
            if (
              [...url.searchParams.keys()].length !== 2 ||
              [...url.searchParams.keys()].some((key) => !['instance', 'epoch'].includes(key)) ||
              !validAgentId(instance) ||
              !/^(0|[1-9]\d*)$/.test(rawEpoch || '') ||
              !Number.isSafeInteger(Number(rawEpoch))
            )
              throw new Fault('INVALID_REQUEST', 400);
            const epoch = Number(rawEpoch);
            const check = () => {
              native.assertInstance(id, instance);
              if (native.control.state(id).epoch !== epoch) throw new Fault('STALE_CONTROL');
            };
            check();
            const image =
              action === 'frame'
                ? await native.frame(id, instance, epoch)
                : await native.browserFrame(id);
            check();
            return reply(res, 200, 'image/jpeg', image);
          }
          if (action === 'frame' && req.method === 'GET')
            return reply(res, 200, 'image/jpeg', await runtime.frame(id));
          if (action === 'browser-frame' && req.method === 'GET' && 'browserFrame' in runtime)
            return reply(res, 200, 'image/jpeg', await runtime.browserFrame(id));
          if (req.method !== 'POST') throw new Fault('METHOD_NOT_ALLOWED', 405);
          const data = await body(req);
          if (native) {
            const fields: Record<string, string[]> = {
              control: ['epoch', 'owner', 'instance'],
              input: ['epoch', 'input', 'instance'],
              app: ['epoch', 'app', 'instance'],
              worker: ['running', 'instance'],
            };
            if (
              !fields[action] ||
              Object.keys(data).some((key) => !fields[action].includes(key)) ||
              !validAgentId(data.instance) ||
              (action !== 'worker' && (!Number.isSafeInteger(data.epoch) || Number(data.epoch) < 0))
            )
              throw new Fault('INVALID_REQUEST', 400);
            native.assertInstance(id, data.instance);
          }
          if (action === 'control')
            return json(
              res,
              native
                ? await native.transfer(
                    id,
                    Number(data.epoch),
                    String(data.owner),
                    String(data.instance),
                  )
                : await runtime.transfer(
                    id,
                    typeof data.epoch === 'number' ? data.epoch : -1,
                    String(data.owner),
                  ),
            );
          if (action === 'input') {
            if (native)
              await native.input(id, Number(data.epoch), data.input, String(data.instance));
            else
              await runtime.input(id, typeof data.epoch === 'number' ? data.epoch : -1, data.input);
            return json(res, { ok: true });
          }
          if (action === 'app' && 'openApp' in runtime) {
            await runtime.openApp(
              id,
              typeof data.epoch === 'number' ? data.epoch : -1,
              String(data.app),
              String(data.instance),
            );
            return json(res, { ok: true });
          }
          if (action === 'worker' && typeof data.running === 'boolean') {
            if (data.running && models?.running(id)) throw new Fault('MODEL_ALREADY_RUNNING');
            await (data.running ? runtime.startWorker(id) : runtime.stopWorker(id));
            return json(res, { ok: true });
          }
          throw new Fault('INVALID_REQUEST', 400);
        }
        if (host) throw new Fault('NOT_FOUND', 404);
        const signedIn = /(?:^|;\s*)demo_session=synthetic-user(?:;|$)/.test(
          req.headers.cookie || '',
        );
        if (req.method === 'GET' && url.pathname === '/fixture/session')
          return json(res, { user: signedIn ? '示例用户' : null });
        if (req.method === 'POST' && ['/fixture/login', '/fixture/logout'].includes(url.pathname)) {
          const login = url.pathname === '/fixture/login';
          // shortcut: this deliberately public synthetic identity tests cookie mechanics, never real authentication.
          res.setHeader(
            'set-cookie',
            `demo_session=${login ? 'synthetic-user' : ''}; HttpOnly; SameSite=Strict; Path=/fixture; Max-Age=${login ? 86400 : 0}`,
          );
          return json(res, { user: login ? '示例用户' : null });
        }
        if (req.method !== 'GET') throw new Fault('METHOD_NOT_ALLOWED', 405);
        if (url.pathname === '/' && !authority.accepts(req.headers['x-prototype-token']))
          return json(res, { service: 'daban', authentication: 'ssh-file' });
        if (url.pathname === '/')
          return reply(
            res,
            200,
            'text/html; charset=utf-8',
            assets
              .get(runtime instanceof Computers ? 'managed.html' : 'index.html')!
              .toString()
              .replace('__PROTOTYPE_TOKEN__', token),
          );
        if (
          url.pathname === '/fixture/page' &&
          (runtime instanceof Computers
            ? validAgentId(url.searchParams.get('bot'))
            : ['a', 'b'].includes(url.searchParams.get('bot') || ''))
        )
          return reply(
            res,
            200,
            'text/html; charset=utf-8',
            assets
              .get('fixture.html')!
              .toString()
              .replaceAll('__BOT__', url.searchParams.get('bot')!.toUpperCase()),
          );
        const publicAssets: Record<string, [string, string]> = {
          '/style.css': ['style.css', 'text/css'],
          '/app.js': ['app.js', 'text/javascript'],
          '/fixture/style.css': ['fixture.css', 'text/css'],
          '/fixture/app.js': ['fixture.js', 'text/javascript'],
        };
        const asset = publicAssets[url.pathname];
        if (asset) return reply(res, 200, `${asset[1]}; charset=utf-8`, assets.get(asset[0]));
        throw new Fault('NOT_FOUND', 404);
      } catch (error) {
        if (!res.headersSent)
          json(
            res,
            { error: errorCode(error) || 'INTERNAL_ERROR' },
            error instanceof Fault ? error.status : 500,
          );
        else res.end();
      } finally {
        releaseMutation?.();
        releaseUpdate?.();
      }
    },
    host ? path.join(modelDir, 'control-certificate.pem') : undefined,
    host ? process.platform : 'darwin',
  );
  const server = channel.server;
  await new Promise<unknown>((resolve, reject) => {
    server.once('error', reject);
    if (host) server.listen(host.socketPath, () => resolve(undefined));
    else server.listen(port, '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  if (!address || (!host && typeof address === 'string')) throw new Error('Invalid server address');
  if (host) {
    if (process.platform !== 'win32') await chmod(host.socketPath, 0o600);
    await channel.publish();
  } else origin = `http://127.0.0.1:${(address as import('node:net').AddressInfo).port}`;
  let closing: Promise<unknown> | undefined;
  const close = () => {
    if (!closing) closing = shutdown();
    return closing;
  };
  async function shutdown() {
    ready = false;
    let failure: unknown;
    // A failed owner must not prevent the remaining stores, computer and HTTP listener from closing.
    for (const owner of [
      recovery,
      linuxRecovery,
      lifecycle,
      documents,
      groups,
      schedules,
      models,
      commands,
      hostBrowser,
      localCommands,
      runtime,
    ]) {
      try {
        await owner?.close();
      } catch (error) {
        failure ||= error;
      }
    }
    server.closeAllConnections();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    if (failure) throw failure;
  }
  try {
    // Publish only after binding: a pre-existing listener must never receive the new credential.
    await authority.publish();
    await appAuthority?.publish();
    if (host?.execution && !host.nativeWorkspace) {
      const snapshot = await host.execution!.ready;
      if (!isExecutionSnapshot(snapshot)) throw new Fault('EXECUTION_INVALID_RESPONSE');
      executionSnapshot = snapshot;
      recovery = createHostRecovery(snapshot);
      await recovery.ready;
    } else if (host?.nativeWorkspace) {
      await optionalLinux();
      const cached = host.execution?.snapshot;
      if (cached && isExecutionSnapshot(cached)) {
        executionSnapshot = cached;
        linuxRecovery = createHostRecovery(cached);
        await linuxRecovery.ready;
      }
      const nativeBoot = `native-${host.scope.slice(0, 24)}`;
      const nativeRecoveryFile = path.join(modelDir, 'native-recovery.json');
      // Keep old Linux recovery receipts in place. Copy a known native receipt so pending native work stays fenced.
      const previousFile = await open(
        path.join(modelDir, 'recovery.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).catch((error: unknown) => {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
          return undefined;
        throw error;
      });
      let previous: string | undefined;
      if (previousFile) {
        try {
          const info = await previousFile.stat();
          if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024)
            throw new Fault('RECOVERY_STORE_UNAVAILABLE');
          previous = await previousFile.readFile('utf8');
        } finally {
          await previousFile.close();
        }
      }
      if (previous) {
        let value: { receipt?: { review?: { boot?: string } } } | undefined;
        try {
          value = JSON.parse(previous);
        } catch {
          /* Linux recovery validates its own legacy file. */
        }
        if (value?.receipt?.review?.boot === nativeBoot)
          await writeFile(nativeRecoveryFile, previous, { flag: 'wx', mode: 0o600 }).catch(
            (error: unknown) => {
              if (
                !error ||
                typeof error !== 'object' ||
                !('code' in error) ||
                error.code !== 'EEXIST'
              )
                throw error;
            },
          );
      }
      recovery = new Recovery({
        file: nativeRecoveryFile,
        boot: nativeBoot,
        instance: `native-${randomBytes(18).toString('base64url')}`,
        quiesce: async () => {
          await Promise.all([groups?.drain(), schedules?.drain()]);
        },
        snapshot: () => ({
          computersRevision: 0,
          screens: [],
          running: [...(models?.jobs.values() || [])]
            .filter((job) => models!.running(job.bot))
            .map((job) => job.bot),
          changing: changing.size > 0 || !!models?.bundles.busy,
        }),
      });
      await recovery.ready;
    } else if (computers) {
      const options = typeof computers === 'object' ? computers : {};
      const dir = options.dir || path.resolve(profileDir, '../desktops');
      runtime = new Computers({
        file: path.resolve(profileDir, '../model/computers.sqlite'),
        limit: options.limit ?? 2,
        boot:
          process.platform === 'linux'
            ? (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
            : 'unsupported-runtime',
        driver: new Machine({
          dir,
          profileDir,
          origin,
          viewers,
          displayBase: options.displayBase ?? 11,
        }),
        registered: async (bot) => !!(await models?.profiles.get(bot)),
        admit: (bot) => models?.admit(bot) ?? false,
        busy: (bot) => (recovery ? !recovery.admit() : false) || !!models?.running(bot),
        drain: async (bot) => models?.drainComputer(bot),
      });
      await runtime.ready;
      const managed = runtime;
      recovery = new Recovery({
        file: path.resolve(profileDir, '../model/recovery.json'),
        quiesce: async () => {
          await Promise.all([groups?.drain(), schedules?.drain()]);
        },
        boot: managed.options.boot,
        instance: `runtime-${randomBytes(18).toString('base64url')}`,
        snapshot: () => {
          const status = managed.status();
          if (!status.available) throw new Fault('RECOVERY_COMPUTER_STATE_UNAVAILABLE', 503);
          return {
            computersRevision: status.revision,
            screens: status.items
              .filter((row) => row.reserved)
              .map((computer) => {
                let lease: ReturnType<typeof managed.control.state> | undefined;
                try {
                  lease = managed.control.state(computer.bot);
                } catch (error) {
                  if (errorCode(error) !== 'UNKNOWN_BOT') throw error;
                }
                return { computer, ...(lease ? { lease } : {}) };
              }),
            running: [...(models?.jobs.values() ?? [])]
              .filter((job) => models!.running(job.bot))
              .map((job) => job.bot),
            changing:
              !!models?.bundles.busy ||
              status.items.some((row) => ['connecting', 'stopping'].includes(row.phase)),
          };
        },
      });
      await recovery.ready;
    } else if (desktop) {
      try {
        runtime = await createDesktop({
          profileDir,
          origin,
          interval,
          viewers,
          fixture,
          ...(typeof desktop === 'object' ? desktop : {}),
        });
      } catch {
        // Computer startup is optional; never move ordinary Agent data to a new fallback workspace.
      }
    } else runtime = await createBrowser({ profileDir, origin, interval, fixture });
    if (host || desktop || computers) {
      const desktopDir =
        typeof computers === 'object' && computers.dir
          ? computers.dir
          : typeof desktop === 'object' && desktop.dir
            ? desktop.dir
            : path.resolve(profileDir, '../desktops');
      files = host?.nativeWorkspace
        ? new NativeWorkspace(host.nativeWorkspace)
        : host
          ? new RemoteWorkspace(
              host.execution!,
              host.offlineWorkspaceRoot,
              undefined,
              host.offlineWorkspaceRoot,
            )
          : new WorkspaceFiles(path.join(desktopDir, 'shared'));
      await files.prepare();
      models = new ModelRuns({
        ...(host ? { documents } : {}),
        software,
        admit: () =>
          upgrade.admit() &&
          !replacingRecovery &&
          (!host || !!host.nativeWorkspace || computerAvailable) &&
          (recovery?.admit() ?? true),
        ...(host
          ? {
              execution: host.nativeWorkspace ? undefined : host.execution!,
              nativeOnly: !!host.nativeWorkspace,
              localComputer: host.localComputer,
              sdkFile: host.sdkFile,
              bridgeSocket: host.socketPath,
              stdioEntry: host.stdioEntry,
              admitBot: (bot: string) => !changing.has(bot),
            }
          : {}),
        runtime: runtime instanceof Desktop ? runtime : undefined,
        computer: runtime instanceof Computers ? runtime.facade : undefined,
        hostBrowser: hostBrowser?.facade,
        workspace: files,
        settings,
        search: searches,
        origin,
        dir: modelDir,
      });
      await models.ready;
      if (host?.nativeWorkspace) {
        const folders = new Folders(path.join(modelDir, 'folders.json'), [host.dataRoot], (run) => {
          if (!models || !upgrade.admit() || replacingRecovery || (recovery && !recovery.admit()))
            throw new Fault('RUNTIME_RECOVERY_PENDING');
          models.profiles.assertRegistered(run.bot);
          models.profiles.assertActive(run.bot);
          const job = models.jobs.get(run.bot);
          if (!job?.running || job.id !== run.id || job.abort.signal.aborted)
            throw new Fault('MODEL_CANCELLED');
        });
        models.tools.localFiles = new LocalTools(folders, models.interactions);
        if (host.runLocalCommand && process.platform !== 'win32') {
          localCommands = new Commands({
            file: path.join(modelDir, 'local-commands.sqlite'),
            interactions: models.interactions,
            target: 'host-local',
            assertLive: (run) => {
              if (replacingRecovery || !upgrade.admit() || (recovery && !recovery.admit()))
                throw new Fault('RUNTIME_RECOVERY_PENDING');
              models!.profiles.assertActive(run.bot);
              const job = models!.jobs.get(run.bot);
              if (!job?.running || job.id !== run.id || job.abort !== run.abort)
                throw new Fault('COMMAND_CANCELLED');
            },
          });
          await localCommands.ready;
          models.tools.localCommands = new LocalCommandTools(
            folders,
            localCommands,
            host.runLocalCommand,
          );
        }
      }
      if (host?.execution) {
        commands = new Commands({
          file: path.join(modelDir, 'commands.sqlite'),
          interactions: models.interactions,
          review: new Risk({
            settings,
            resolve: async (request) => models?.reviewModel(request.bot, request.runId) ?? null,
          }).review,
          assertLive: (run) => {
            if (
              replacingRecovery ||
              !recovery!.admit() ||
              (linuxRecovery && !linuxRecovery.admit())
            )
              throw new Fault('RUNTIME_RECOVERY_PENDING');
            models!.profiles.assertActive(run.bot);
            const job = models!.jobs.get(run.bot);
            if (!job?.running || job.id !== run.id || job.abort !== run.abort)
              throw new Fault('COMMAND_CANCELLED');
          },
        });
        await commands.ready;
        models.tools.executeRemote = commands.invoke.bind(commands);
        if (host.nativeWorkspace) {
          models.tools.linux = new LinuxTools(host.execution, files, models.tools, async () => {
            await refreshExecution();
            if (!linuxRecovery?.admit()) throw new Fault('RUNTIME_RECOVERY_PENDING');
          });
          models.tools.linux.enabled = linuxAvailable;
        }
      }
      schedules = new Schedules({
        file: path.join(modelDir, 'schedules.sqlite'),
        domain: nativeSchedules(host?.sdkFile),
        runner: {
          running: (bot) => models!.running(bot),
          admit: (bot) => models!.admit(bot),
          findRequest: (bot, id) => models!.findRequest(bot, id),
          start: (bot, task) =>
            models!.start(bot, { ...task, chatRevision: models!.chats.current(bot).revision }),
        },
      });
      try {
        await schedules.ready;
        models.tools.schedules = new ScheduleTools(schedules);
      } catch {
        // An unavailable schedule service must not prevent ordinary conversation or desktop access.
      }
      groups = new Groups(
        path.join(modelDir, 'groups.sqlite'),
        {
          member: (bot) => models!.profiles.get(bot),
          directory: async () =>
            (await models!.profiles.list()).filter((profile) => profile.kind !== 'chat'),
          source: (bot, runId, group) => models!.groupSource(bot, runId, group),
          running: (bot) => models!.running(bot),
          groupRunning: (group) => models!.groupRunning(group),
          admit: (bot) => models!.admit(bot),
          findRequest: (bot, id) => models!.findRequest(bot, id),
          start: (bot, task, scope) => models!.start(bot, task, scope),
          stopRequest: (bot, id, group) => models!.stopRequest(bot, id, group),
        },
        models.attachments,
      );
      models.attachmentPinned = (owner, id) => groups!.inputBusy(owner, id);
      try {
        await groups.ready;
        models.tools.groups = new GroupTools(groups);
      } catch {
        // Keep ordinary Agent and computer access available when group storage needs repair.
      }
      if (host || runtime instanceof Computers) {
        const computers = runtime;
        lifecycle = new BotLifecycle({
          profiles: models.profiles,
          running: (bot) => models!.running(bot),
          assertIdle: async (bot) => {
            if (models!.running(bot)) throw new Fault('BOT_TASK_RUNNING');
            if (changing.has(bot)) throw new Fault('BOT_COMPUTER_CONNECTED');
            if ((await host?.localComputer?.status())?.session?.bot === bot)
              throw new Fault('BOT_COMPUTER_CONNECTED');
            if (hostBrowser?.selected(bot)) throw new Fault('BOT_COMPUTER_CONNECTED');
            if (host?.nativeWorkspace) {
              if (executionSnapshot?.status.items.some((item) => item.bot === bot && item.reserved))
                throw new Fault('BOT_COMPUTER_CONNECTED');
              if (await groups!.hasPendingBot(bot)) throw new Fault('BOT_GROUP_PENDING');
              return;
            }
            const status = host
              ? (await refreshExecution()).status
              : (computers as Computers).status();
            if (changing.has(bot)) throw new Fault('BOT_COMPUTER_CONNECTED');
            if (!status.available) throw new Fault('BOT_COMPUTER_STATE_UNAVAILABLE');
            const state = status.items.find((item) => item.bot === bot);
            if (state && (state.reserved || !['disconnected', 'failed'].includes(state.phase)))
              throw new Fault('BOT_COMPUTER_CONNECTED');
            if (await groups!.hasPendingBot(bot)) throw new Fault('BOT_GROUP_PENDING');
          },
          suspendSchedules: (bot) => schedules!.suspendBot(bot),
        });
        // Accepted archive intents must fence and pause automatic work before its timers can wake.
        await lifecycle.recover();
      }
      schedules.start();
      groups.start();
    }
    ready = true;
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return {
    url: origin,
    token,
    get runtime() {
      if (!runtime) throw new Fault('COMPUTER_NOT_CONNECTED', 503);
      return runtime;
    },
    models,
    schedules,
    groups,
    lifecycle,
    get recovery() {
      return recovery;
    },
    get executionRecovery() {
      return linuxRecovery;
    },
    ...(host ? { refreshExecution } : {}),
    close,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const app = await startPrototype({
    // Availability is dynamic: the root broker may finish starting after this runtime.
    software: platform() === 'linux' ? new SoftwareClient() : undefined,
    port: Number(process.env.PORT || 8766),
    profileDir: process.env.PROFILE_DIR,
    computers:
      process.env.DESKTOP_MODE === '1'
        ? { limit: Number(process.env.COMPUTER_SLOTS || 2) }
        : undefined,
    fixture: process.env.BROWSER_FIXTURE === '1',
  });
  console.log(`Local runtime ready: ${app.url}`);
  console.log(
    'Scoped agent tools and optional computer access; the browser fixture uses synthetic data.',
  );
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
