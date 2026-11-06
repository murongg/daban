import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { inspectSkillPackage } from '@daban/engine/skill-package';
import {
  botBundleLimit,
  botBundleText,
  botCopyKey,
  diagnosticModel,
  disconnected,
  groupCopyKey,
  imageProtocol,
  isAttachmentEntry,
  isAttachmentOriginal,
  isAttachmentPage,
  isAttachmentPurge,
  isAttachmentReceipt,
  isBotBundle,
  isBotCopyReceipt,
  isBotImportReceipt,
  isBotLifecycleAck,
  isBotProfile,
  isBrowserAck,
  isBrowserReceipt,
  isBrowserState,
  isBrowserView,
  isChatAck,
  isChatPage,
  isChatStatus,
  isComputerAck,
  isComputerStatus,
  isDiagnosticReport,
  isDocumentOriginal,
  isGoalProgress,
  isGroup,
  isGroupActionAck,
  isGroupCopyReceipt,
  isGroupPage,
  isInteraction,
  isKnowledgeDocument,
  isKnowledgeFile,
  isKnowledgeVersion,
  isLegacyWorkQuery,
  isLegacyWorkWrite,
  isLocalComputerStatus,
  isMcpAssignments,
  isMcpBindingResult,
  isMcpCatalog,
  isMcpCommand,
  isMcpConnection,
  isMcpHistory,
  isMcpList,
  isMcpReceipt,
  isMcpSaved,
  isMcpStatus,
  isMemoryPage,
  isModelAccess,
  isModelAttempts,
  isModelCheck,
  isModelConnection,
  isModelId,
  isModelInspection,
  isModelSaved,
  isModelStatus,
  isNoteAvailability,
  isNoteCommand,
  isNoteItem,
  isNoteList,
  isNoteReceipt,
  isNoteStatusResult,
  isRebootStatus,
  isRecoveryReceipt,
  isRecoveryReview,
  isRecoveryStatus,
  isReplyStream,
  isRunInsert,
  isRunStatistics,
  isRunTurn,
  isRuntimeDownload,
  isRuntimeNoticeStatus,
  isSchedule,
  isScheduleFiring,
  isSkillArchiveResult,
  isSkillBindingResult,
  isSkillCatalogResult,
  isSkillDocument,
  isSkillResourceData,
  isSkillStatus,
  isSoftwareState,
  isTaskFile,
  isTaskPlan,
  isTranscriptContent,
  isTranscriptPage,
  isWorkCommentCommand,
  isWorkCommentList,
  isWorkCommentReceipt,
  isWorkItem,
  isWorkList,
  isWorkReceipt,
  isWorkStatus,
  noteKey,
  noteQueryKey,
  parseBotJSON,
  type RecoveryReceipt,
  type RecoveryRequest,
  type RuntimeCommand,
  type RuntimeFile,
  type RuntimeSnapshot,
  type RuntimeTask,
  recoveryBlocked,
  sameTranscriptScope,
  unavailableLocalComputer,
  validAgentId,
  workCommentKey,
  workCommentQueryKey,
  workKey,
  workQueryKey,
} from '@daban/protocol';
import type { MessageKey } from '../shared/locale';
import { isTaskReceipt } from '../shared/receipt';

// SSH forwards TCP unchanged. Use Node HTTP so the guest's canonical Host header is preserved.
async function localRequest(url: string, init: RequestInit = {}): Promise<Response> {
  const body = init.body;
  const responseLimit =
    new URL(url).pathname === '/api/bundles/export' ? botBundleLimit + 64 * 1024 : 16 * 1024 * 1024;
  if (body !== undefined && typeof body !== 'string') throw new Error('INVALID_INTERNAL_BODY');
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method || 'GET',
        headers: Object.fromEntries(new Headers(init.headers)),
        signal: init.signal || undefined,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > responseLimit) {
            req.destroy(new Error('RUNTIME_RESPONSE_TOO_LARGE'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined)
              for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
          resolve(
            new Response(new Uint8Array(Buffer.concat(chunks)), {
              status: response.statusCode || 500,
              headers,
            }),
          );
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function runtimeTask(task: Partial<RuntimeTask> = {}): RuntimeTask {
  if (
    (task.attemptSummary !== undefined && !isModelAttempts(task.attemptSummary)) ||
    (task.rootRunId !== undefined && !validAgentId(task.rootRunId))
  )
    throw new Error('INVALID_RUNTIME_STATE');
  if (
    task.chatRevision !== undefined &&
    (!Number.isSafeInteger(task.chatRevision) || task.chatRevision < 0)
  )
    throw new Error('INVALID_RUNTIME_STATE');
  if (task.conversationId !== undefined && !validAgentId(task.conversationId))
    throw new Error('INVALID_RUNTIME_STATE');
  if (
    (task.history || []).some(
      (item) =>
        (item.conversationId !== undefined && !validAgentId(item.conversationId)) ||
        (item.chatRevision !== undefined &&
          (!Number.isSafeInteger(item.chatRevision) || item.chatRevision < 0)),
    )
  )
    throw new Error('INVALID_RUNTIME_STATE');
  return {
    ...(isModelAttempts(task.attemptSummary) ? { attemptSummary: task.attemptSummary } : {}),
    ...(task.rootRunId ? { rootRunId: task.rootRunId } : {}),
    ...(typeof task.planning === 'boolean' ? { planning: task.planning } : {}),
    ...(isGoalProgress(task.goal) ? { goal: task.goal } : {}),
    chatRevision: task.chatRevision,
    ...(task.conversationId ? { conversationId: task.conversationId } : {}),
    ...(isModelId(task.model) ? { model: task.model } : {}),
    response: isReplyStream(task.response) ? task.response : undefined,
    elapsedMs:
      Number.isSafeInteger(task.elapsedMs) && task.elapsedMs! >= 0 ? task.elapsedMs : undefined,
    plan: isTaskPlan(task.plan) ? task.plan : undefined,
    phase: task.phase || 'idle',
    running: task.running === true,
    prompt: task.prompt || '',
    files: task.files || [],
    result: task.result || '',
    error: task.error || '',
    toolCount: task.toolCount || 0,
    executedCount: task.executedCount || 0,
    runId: task.runId,
    requestId: task.requestId,
    sessionId: task.sessionId,
    outputDirectory: task.outputDirectory,
    trace: task.trace || [],
    ...(Array.isArray(task.turns) && task.turns.every(isRunTurn) ? { turns: task.turns } : {}),
    ...(Array.isArray(task.inserts) && task.inserts.every(isRunInsert)
      ? { inserts: task.inserts }
      : {}),
    history: (task.history || []).map((item) => ({
      ...(isModelAttempts(item.attemptSummary) ? { attemptSummary: item.attemptSummary } : {}),
      ...(validAgentId(item.rootRunId) ? { rootRunId: item.rootRunId } : {}),
      chatRevision: item.chatRevision,
      ...(item.conversationId ? { conversationId: item.conversationId } : {}),
      runId: item.runId,
      requestId: item.requestId,
      phase: item.phase,
      prompt: item.prompt,
      result: item.result,
      error: item.error,
      files: item.files,
      ...(Array.isArray(item.turns) && item.turns.every(isRunTurn) ? { turns: item.turns } : {}),
      response: isReplyStream(item.response) ? item.response : undefined,
      elapsedMs:
        Number.isSafeInteger(item.elapsedMs) && item.elapsedMs! >= 0 ? item.elapsedMs : undefined,
    })),
  };
}

interface Options {
  origin: string;
  serverOrigin?: string;
  tokenProvider?: () => Promise<string | undefined>;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
  agent?: boolean;
}
export class RuntimeClient {
  readonly origin: string;
  private readonly serverHost: string;
  private readonly fetcher: NonNullable<Options['fetcher']>;
  private token = '';
  private readonly tokenProvider?: Options['tokenProvider'];
  private authenticating?: Promise<unknown>;
  private readonly agent: boolean;
  private stateProtocol = 28;
  constructor({ origin, serverOrigin = origin, fetcher, tokenProvider, agent = false }: Options) {
    const url = new URL(origin);
    if (agent && !fetcher) throw new Error('AGENT_TRANSPORT_REQUIRED');
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      url.username ||
      url.password ||
      !['', '/'].includes(url.pathname) ||
      url.search ||
      url.hash ||
      (agent && url.origin !== 'http://127.0.0.1:8766')
    )
      throw new Error('INVALID_RUNTIME_ORIGIN');
    const server = new URL(serverOrigin);
    if (
      server.protocol !== 'http:' ||
      server.hostname !== '127.0.0.1' ||
      server.username ||
      server.password
    )
      throw new Error('INVALID_RUNTIME_ORIGIN');
    this.origin = url.origin;
    this.serverHost = server.host;
    this.fetcher = fetcher ?? localRequest;
    this.tokenProvider = tokenProvider;
    this.agent = agent;
  }
  private async authenticate() {
    if (this.token) return;
    if (!this.authenticating)
      this.authenticating = (async () => {
        const privateToken = await this.tokenProvider?.();
        if (privateToken !== undefined) {
          if (!/^[a-f0-9]{64}$/.test(privateToken)) throw new Error('RUNTIME_AUTH_UNAVAILABLE');
          this.token = privateToken;
          return;
        }
        const response = await this.fetcher(`${this.origin}/`, {
          headers: { host: this.serverHost },
          signal: AbortSignal.timeout(6000),
        });
        const html = await response.text();
        const token = html.match(/name="prototype-token" content="([a-zA-Z0-9_-]+)"/)?.[1];
        if (!response.ok || !token) throw new Error('RUNTIME_AUTH_UNAVAILABLE');
        if (this.tokenProvider) {
          const state = await this.fetcher(`${this.origin}/api/state`, {
            headers: { host: this.serverHost, 'x-prototype-token': token },
            signal: AbortSignal.timeout(6000),
          });
          const value = (await state.json()) as { clientProtocol?: unknown };
          // A proven missing private file permits old services only; read errors never downgrade.
          if (
            !state.ok ||
            !Number.isSafeInteger(value.clientProtocol) ||
            Number(value.clientProtocol) < 1 ||
            Number(value.clientProtocol) > 24
          )
            throw new Error('RUNTIME_AUTH_UNAVAILABLE');
        }
        this.token = token;
      })().finally(() => {
        this.authenticating = undefined;
      });
    return this.authenticating;
  }
  private async api(route: string, data?: unknown, retry = true, protocol = 28): Promise<unknown> {
    await this.authenticate();
    const token = this.token;
    const response = await this.fetcher(this.origin + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        host: this.serverHost,
        'x-prototype-token': token,
        // Unchanged group shapes keep28; Work passes its proven format explicitly.
        'x-daban-client-protocol': String(protocol),
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(
        route === '/api/host/recovery'
          ? 600000
          : route.startsWith('/api/bundles/')
            ? 120000
            : 20000,
      ),
    });
    const decode = async () =>
      route.startsWith('/api/bundles/') ? parseBotJSON(await response.text()) : response.json();
    if (response.status === 403 && retry) {
      const result = (await decode()) as { error?: string };
      // Only explicit authentication rejection is retryable; network loss after a mutation is ambiguous.
      if (result.error === 'UNAUTHORIZED') {
        if (this.token === token) this.token = '';
        if (data !== undefined) throw new Error('RUNTIME_SESSION_CHANGED');
        return this.api(route, data, false, protocol);
      }
      throw new Error('RUNTIME_REQUEST_DENIED');
    }
    if (!response.ok) {
      const body = (await decode().catch(() => ({}))) as { error?: unknown };
      throw new Error(
        typeof body.error === 'string' && /^[A-Z_]+$/.test(body.error)
          ? body.error
          : 'RUNTIME_REQUEST_FAILED',
      );
    }
    if (response.headers.get('content-type')?.startsWith('image/jpeg'))
      return `data:image/jpeg;base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
    return decode();
  }
  private workApi(route: string, data: unknown, protocolVersion: number) {
    return this.api(route, data, true, protocolVersion >= 39 ? 39 : 28);
  }
  async status(): Promise<RuntimeSnapshot> {
    try {
      let [data, settings] = (await Promise.all([
        this.api('/api/state', undefined, true, this.stateProtocol),
        this.api('/api/model/settings'),
      ])) as [Record<string, unknown>, { configured?: boolean }];
      const protocol =
        Number.isSafeInteger(data.clientProtocol) && Number(data.clientProtocol) >= 46 ? 46 : 28;
      if (this.stateProtocol !== protocol) {
        // Older services downgrade future group shapes; negotiate before asking for the new chat catalogue.
        this.stateProtocol = protocol;
        data = (await this.api('/api/state', undefined, true, protocol)) as Record<string, unknown>;
      }
      const raw = data as unknown as {
        clientProtocol?: number;
        botCapabilities?: unknown;
        localComputer?: unknown;
        chats?: unknown;
        notices?: unknown;
        recovery?: unknown;
        reboot?: unknown;
        agent?: unknown;
        computers?: unknown;
        skills?: unknown;
        software?: unknown;
        mcp?: unknown;
        browsers?: Record<string, unknown>;
        groups?: { available?: unknown; revision?: unknown; items?: unknown[]; error?: unknown };
        profiles?: unknown[];
        interactions?: unknown[];
        schedules?: { available?: unknown; items?: unknown[]; error?: unknown };
        knowledge?: {
          available?: unknown;
          revision?: unknown;
          error?: unknown;
          documentParsing?: unknown;
        };
        work?: unknown;
        notes?: unknown;
        mode?: string;
        computerError?: unknown;
        sharedLogin?: boolean;
        model?: {
          modelAccess?: unknown;
          fallbackModel?: unknown;
          probeRevision?: unknown;
          connections?: unknown;
          inspection?: unknown;
          revision?: number;
          available?: boolean;
          provider?: string;
          model?: string;
          bots?: Record<string, Partial<RuntimeTask>>;
        };
        bots?: Record<string, { owner?: string; epoch?: number; instance?: unknown }>;
      };
      const agentOnly = raw.mode === 'agent';
      const managed = (raw.clientProtocol || 0) >= 19;
      if (managed) {
        if (
          !Number.isSafeInteger(raw.clientProtocol) ||
          !isComputerStatus(raw.computers) ||
          !raw.bots ||
          typeof raw.bots !== 'object' ||
          Array.isArray(raw.bots) ||
          raw.computerError !== undefined
        )
          throw new Error('INVALID_RUNTIME_STATE');
        const connected = raw.computers.items.filter((item) => item.phase === 'connected');
        if (
          (!raw.computers.available && connected.length) ||
          raw.mode !== (connected.length ? 'desktop' : 'agent') ||
          Object.keys(raw.bots).length !== connected.length ||
          connected.some(
            (item) =>
              !Object.hasOwn(raw.bots!, item.bot) ||
              raw.bots![item.bot]?.instance !== item.instance,
          )
        )
          throw new Error('INVALID_RUNTIME_STATE');
      } else if (agentOnly) {
        // Missing screens are valid only when explicitly advertised; never infer readiness from broken desktop metadata.
        if (
          !Number.isSafeInteger(raw.clientProtocol) ||
          (raw.clientProtocol || 0) < 17 ||
          raw.computerError !== 'COMPUTER_START_FAILED' ||
          !raw.bots ||
          typeof raw.bots !== 'object' ||
          Array.isArray(raw.bots) ||
          Object.keys(raw.bots).length !== 0 ||
          raw.sharedLogin !== false ||
          (raw.browsers !== undefined &&
            (!raw.browsers ||
              typeof raw.browsers !== 'object' ||
              Array.isArray(raw.browsers) ||
              Object.keys(raw.browsers).length !== 0))
        )
          throw new Error('INVALID_RUNTIME_STATE');
      } else if (
        raw.mode !== 'desktop' ||
        !raw.bots?.a ||
        !raw.bots.b ||
        raw.computerError !== undefined
      ) {
        throw new Error('INVALID_RUNTIME_STATE');
      }
      if ((raw.clientProtocol || 0) >= 13 && !isModelStatus(settings))
        throw new Error('INVALID_RUNTIME_STATE');
      if (
        (raw.model?.modelAccess !== undefined && !isModelAccess(raw.model.modelAccess)) ||
        (raw.model?.fallbackModel !== undefined && !isModelId(raw.model.fallbackModel)) ||
        (raw.model?.probeRevision !== undefined &&
          (!Number.isSafeInteger(raw.model.probeRevision) || Number(raw.model.probeRevision) < 0))
      )
        throw new Error('INVALID_RUNTIME_STATE');
      if (
        raw.model?.connections !== undefined &&
        (!Array.isArray(raw.model.connections) ||
          raw.model.connections.length > 20 ||
          !raw.model.connections.every(isModelConnection))
      )
        throw new Error('INVALID_RUNTIME_STATE');
      const snapshot = disconnected('ready');
      snapshot.protocolVersion = raw.clientProtocol || 0;
      // Protocol updates for other features do not imply Bot-owned installation support.
      if (raw.botCapabilities === true) snapshot.botCapabilities = true;
      if (this.agent && raw.localComputer !== undefined)
        snapshot.localComputer = isLocalComputerStatus(raw.localComputer)
          ? raw.localComputer
          : unavailableLocalComputer('LOCAL_INVALID_STATUS');
      if (this.agent) {
        if (
          raw.agent &&
          typeof raw.agent === 'object' &&
          'execution' in raw.agent &&
          raw.agent.execution === 'local-workspace'
        ) {
          const role = raw.agent as Record<string, unknown>;
          if (
            Object.keys(role).length !== 4 ||
            role.location !== 'host' ||
            role.privilege !== 'workspace' ||
            role.approvals !== 'host'
          )
            throw new Error('INVALID_RUNTIME_STATE');
          snapshot.agent = {
            location: 'host',
            execution: 'local-workspace',
            privilege: 'workspace',
            approvals: 'host',
          };
        } else {
          if (!isRebootStatus(raw.reboot)) throw new Error('INVALID_RUNTIME_STATE');
          snapshot.reboot = raw.reboot;
          if (raw.agent !== undefined) {
            const role = raw.agent;
            if (
              !role ||
              typeof role !== 'object' ||
              Object.keys(role).length !== 4 ||
              !('location' in role) ||
              role.location !== 'host' ||
              !('execution' in role) ||
              role.execution !== 'linux-vm' ||
              !('privilege' in role) ||
              role.privilege !== 'sudo' ||
              !('approvals' in role) ||
              role.approvals !== 'host'
            )
              throw new Error('INVALID_RUNTIME_STATE');
            snapshot.agent = {
              location: 'host',
              execution: 'linux-vm',
              privilege: 'sudo',
              approvals: 'host',
            };
          }
        }
      }
      // Software is an additive capability; older VM releases can expose it without enabling unrelated protocol features.
      if (raw.software !== undefined)
        snapshot.software = isSoftwareState(raw.software)
          ? raw.software
          : { available: false, items: [], error: 'SOFTWARE_INVALID_RESPONSE' };
      if (snapshot.protocolVersion >= 37)
        snapshot.notes = isNoteAvailability(raw.notes)
          ? raw.notes
          : { available: false, error: 'INVALID_NOTE_METADATA' };
      // A broken optional work store must not turn an otherwise usable Agent into an offline client.
      if (snapshot.protocolVersion >= 36)
        snapshot.work = isWorkStatus(raw.work)
          ? raw.work
          : { available: false, error: 'INVALID_WORK_METADATA' };
      if (snapshot.protocolVersion >= 30)
        snapshot.notices = isRuntimeNoticeStatus(raw.notices)
          ? raw.notices
          : { available: false, items: [], error: 'INVALID_NOTICE_METADATA' };
      if (snapshot.protocolVersion >= 29) {
        if (!isChatStatus(raw.chats)) throw new Error('INVALID_RUNTIME_STATE');
        snapshot.chats = raw.chats;
      }
      if (snapshot.protocolVersion >= 24) {
        if (!isRecoveryStatus(raw.recovery)) throw new Error('INVALID_RUNTIME_STATE');
        snapshot.recovery = raw.recovery;
      }
      if (snapshot.protocolVersion >= 21) {
        if (!isMcpStatus(raw.mcp)) throw new Error('INVALID_RUNTIME_STATE');
        snapshot.mcp = raw.mcp;
      }
      if (snapshot.protocolVersion >= 20) {
        if (!isSkillStatus(raw.skills)) throw new Error('INVALID_RUNTIME_STATE');
        snapshot.skills = raw.skills;
      }
      if (agentOnly && !managed) snapshot.computerError = 'COMPUTER_START_FAILED';
      if (managed && isComputerStatus(raw.computers)) snapshot.computers = raw.computers;
      if (snapshot.protocolVersion >= 16 && raw.browsers) {
        snapshot.browsers = {};
        for (const bot of managed ? Object.keys(raw.browsers) : ['a', 'b']) {
          const state = raw.browsers[bot];
          if (state === undefined) continue;
          if (managed && (!validAgentId(bot) || !Object.hasOwn(raw.bots!, bot)))
            throw new Error('INVALID_RUNTIME_STATE');
          if (!isBrowserState(state) || state.bot !== bot) throw new Error('INVALID_RUNTIME_STATE');
          snapshot.browsers[bot] = state;
        }
      }
      if (raw.groups) {
        const value = raw.groups;
        snapshot.groups =
          typeof value.available === 'boolean' &&
          Number.isSafeInteger(value.revision) &&
          Number(value.revision) >= 0 &&
          Array.isArray(value.items) &&
          value.items.length <= 50 &&
          value.items.every(isGroup)
            ? {
                available: value.available,
                revision: Number(value.revision),
                items: value.items,
                ...(typeof value.error === 'string' && /^[A-Z_]+$/.test(value.error)
                  ? { error: value.error }
                  : {}),
              }
            : { available: false, revision: 0, items: [], error: 'INVALID_RUNTIME_STATE' };
      }
      if (raw.knowledge)
        snapshot.knowledge =
          typeof raw.knowledge.available === 'boolean' &&
          (raw.knowledge.documentParsing === undefined ||
            typeof raw.knowledge.documentParsing === 'boolean') &&
          (raw.knowledge.revision === undefined ||
            (Number.isSafeInteger(raw.knowledge.revision) && Number(raw.knowledge.revision) >= 0))
            ? {
                available: raw.knowledge.available,
                ...(typeof raw.knowledge.documentParsing === 'boolean'
                  ? { documentParsing: raw.knowledge.documentParsing }
                  : {}),
                ...(typeof raw.knowledge.revision === 'number'
                  ? { revision: raw.knowledge.revision }
                  : {}),
                ...(typeof raw.knowledge.error === 'string' && /^[A-Z_]+$/.test(raw.knowledge.error)
                  ? { error: raw.knowledge.error }
                  : {}),
              }
            : { available: false, documentParsing: false, error: 'INVALID_RUNTIME_STATE' };
      if (raw.schedules) {
        const value = raw.schedules;
        snapshot.schedules =
          typeof value.available === 'boolean' &&
          Array.isArray(value.items) &&
          value.items.every(isSchedule)
            ? {
                available: value.available,
                items: value.items,
                ...(typeof value.error === 'string' && /^[A-Z_]+$/.test(value.error)
                  ? { error: value.error }
                  : {}),
              }
            : { available: false, items: [], error: 'INVALID_RUNTIME_STATE' };
      }
      snapshot.sharedLogin = Boolean(raw.sharedLogin);
      snapshot.profiles = Array.isArray(raw.profiles) ? raw.profiles.filter(isBotProfile) : [];
      snapshot.interactions = Array.isArray(raw.interactions)
        ? raw.interactions.filter(isInteraction)
        : [];
      snapshot.model = {
        configured: settings.configured === true,
        available: raw.model?.available === true,
        provider: raw.model?.provider || '',
        model: raw.model?.model || '',
        ...(isModelStatus(settings)
          ? {
              model: settings.model,
              provider: settings.provider,
              revision: settings.revision,
              ...(raw.model?.revision === settings.revision && isModelAccess(raw.model.modelAccess)
                ? {
                    modelAccess: raw.model.modelAccess,
                    ...(isModelId(raw.model.fallbackModel)
                      ? { fallbackModel: raw.model.fallbackModel }
                      : {}),
                    ...(typeof raw.model.probeRevision === 'number'
                      ? { probeRevision: raw.model.probeRevision }
                      : {}),
                  }
                : {}),
              ...(raw.model?.inspection === true ? { inspection: true } : {}),
              ...(Array.isArray(raw.model?.connections) && raw.model.revision === settings.revision
                ? { connections: raw.model.connections }
                : {}),
            }
          : {}),
      };
      for (const [id, value] of Object.entries(raw.model?.bots || {})) {
        if (validAgentId(id)) snapshot.agents[id] = runtimeTask(value);
      }
      for (const bot of managed ? Object.keys(raw.bots!) : ['a', 'b']) {
        if (agentOnly && !managed) continue;
        const state = raw.bots![bot];
        if (
          !validAgentId(bot) ||
          !state ||
          !['human', 'agent', 'handoff'].includes(state.owner || '') ||
          !Number.isSafeInteger(state.epoch)
        )
          throw new Error('INVALID_RUNTIME_STATE');
        if (
          snapshot.protocolVersion >= 18 &&
          (!Number.isSafeInteger(snapshot.protocolVersion) ||
            !validAgentId(state.instance) ||
            Number(state.epoch) < 0 ||
            Object.values(snapshot.bots).some((value) => value?.instance === state.instance))
        )
          throw new Error('INVALID_RUNTIME_STATE');
        snapshot.bots[bot] = {
          ...(snapshot.protocolVersion >= 18 ? { instance: state.instance as string } : {}),
          owner: state.owner as 'human' | 'agent' | 'handoff',
          epoch: state.epoch!,
          task: snapshot.agents[bot] || runtimeTask(),
        };
      }
      return snapshot;
    } catch {
      return disconnected('offline', 'errors.runtimeConnectionUnavailable' satisfies MessageKey);
    }
  }
  private async requireRecovery() {
    const state = await this.status();
    if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
    if (state.protocolVersion < 24) throw new Error('RUNTIME_TOO_OLD');
  }
  private recoveryReply(
    value: unknown,
    request: Pick<RecoveryRequest, 'id' | 'revision' | 'review'>,
  ): RecoveryReceipt {
    if (
      !isRecoveryReceipt(value) ||
      value.id !== request.id ||
      value.review.revision !== request.revision ||
      value.review.digest !== request.review
    )
      throw new Error('INVALID_RUNTIME_STATE');
    return value;
  }
  async recoveryReview() {
    await this.requireRecovery();
    const value = await this.api('/api/recovery/review');
    if (!isRecoveryReview(value)) throw new Error('INVALID_RUNTIME_STATE');
    return value;
  }
  async prepareRecovery(request: RecoveryRequest) {
    await this.requireRecovery();
    return this.recoveryReply(await this.api('/api/recovery/prepare', request), request);
  }
  async claimRecovery(request: Pick<RecoveryRequest, 'id' | 'revision' | 'review'>) {
    await this.requireRecovery();
    const value = this.recoveryReply(
      await this.api('/api/recovery/claim', { id: request.id, revision: request.revision + 1 }),
      request,
    );
    if (!['claimed', 'complete'].includes(value.phase)) throw new Error('INVALID_RUNTIME_STATE');
    return value;
  }
  async cancelRecovery(request: Pick<RecoveryRequest, 'id' | 'revision' | 'review'>) {
    await this.requireRecovery();
    const value = this.recoveryReply(
      await this.api('/api/recovery/cancel', { id: request.id, revision: request.revision + 1 }),
      request,
    );
    if (value.phase !== 'cancelled') throw new Error('INVALID_RUNTIME_STATE');
    return value;
  }
  async receiptRecovery(id: string) {
    await this.requireRecovery();
    const value = await this.api('/api/recovery/receipt', { id });
    if (!isRecoveryReceipt(value) || value.id !== id) throw new Error('INVALID_RUNTIME_STATE');
    return value;
  }
  async invoke(command: RuntimeCommand): Promise<unknown> {
    if (this.agent && command.type.startsWith('recovery.')) {
      const captured = structuredClone(command);
      const value = await this.api('/api/host/recovery', captured);
      if (captured.type === 'recovery.review') {
        if (!isRecoveryReview(value)) throw new Error('INVALID_RUNTIME_STATE');
        return value;
      }
      if (!isRebootStatus(value)) throw new Error('INVALID_RUNTIME_STATE');
      if (value.available && captured.type !== 'recovery.status') {
        const operation = value.operation;
        if (captured.type === 'recovery.restart') {
          if (
            !operation ||
            operation.id !== captured.request.id ||
            operation.review.digest !== captured.request.review ||
            operation.review.revision !== captured.request.revision
          )
            throw new Error('INVALID_RUNTIME_STATE');
        } else if ('id' in captured && (!operation || operation.id !== captured.id)) {
          throw new Error('INVALID_RUNTIME_STATE');
        }
      }
      return value;
    }
    if (isWorkCommentCommand(command)) {
      // Snapshot the intent before status yields so a caller cannot change the acknowledged request.
      const captured = structuredClone(command);
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 38) throw new Error('RUNTIME_TOO_OLD');
      if (!state.work?.available) throw new Error(state.work?.error ?? 'WORK_UNAVAILABLE');
      if (captured.type === 'work.comment' && recoveryBlocked(state))
        throw new Error('RUNTIME_RECOVERY_PENDING');
      if (captured.type === 'work.comments') {
        const value = await this.workApi(
          '/api/work/comments',
          captured.query,
          state.protocolVersion,
        );
        if (
          !isWorkCommentList(value) ||
          workCommentQueryKey(value.query) !== workCommentQueryKey(captured.query)
        )
          throw new Error('INVALID_WORK_COMMENT_PAGE');
        return value;
      }
      const value = await this.workApi(
        captured.type === 'work.comment' ? '/api/work/comment' : '/api/work/comment-receipt',
        captured.request,
        state.protocolVersion,
      );
      if (
        !isWorkCommentReceipt(value) ||
        value.actor.kind !== 'human' ||
        workCommentKey(value.request, value.actor) !==
          workCommentKey(captured.request, { kind: 'human' }) ||
        (captured.type === 'work.comment' && value.state !== 'complete')
      )
        throw new Error('INVALID_WORK_COMMENT_ACK');
      return value;
    }
    if (isNoteCommand(command)) {
      // Keep the original Bot and intent even if navigation or authentication changes while status yields.
      const captured = structuredClone(command);
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 37) throw new Error('RUNTIME_TOO_OLD');
      if (!state.notes?.available) throw new Error(state.notes?.error ?? 'NOTES_UNAVAILABLE');
      if (captured.type === 'notes.status') {
        const value = await this.api('/api/notes/status', { bot: captured.bot });
        if (!isNoteStatusResult(value) || value.bot !== captured.bot)
          throw new Error('INVALID_NOTE_METADATA');
        return value;
      }
      if (captured.type === 'notes.list') {
        const value = await this.api('/api/notes/list', {
          bot: captured.bot,
          query: captured.query,
        });
        if (
          !isNoteList(value) ||
          value.bot !== captured.bot ||
          noteQueryKey(value.query) !== noteQueryKey(captured.query)
        )
          throw new Error('INVALID_NOTE_PAGE');
        return value;
      }
      if (captured.type === 'notes.read') {
        const value = await this.api('/api/notes/read', { bot: captured.bot, id: captured.id });
        if (!isNoteItem(value) || value.bot !== captured.bot || value.id !== captured.id)
          throw new Error('INVALID_NOTE_ITEM');
        return value;
      }
      const value = await this.api(
        captured.type === 'notes.write' ? '/api/notes/write' : '/api/notes/receipt',
        { bot: captured.bot, request: captured.request },
      );
      if (
        !isNoteReceipt(value) ||
        value.bot !== captured.bot ||
        value.actor.kind !== 'human' ||
        noteKey(value.bot, value.request, value.actor) !==
          noteKey(captured.bot, captured.request, { kind: 'human' }) ||
        (captured.type === 'notes.write' && value.state !== 'complete')
      )
        throw new Error('INVALID_NOTE_ACK');
      return value;
    }
    if (
      command.type === 'work.list' ||
      command.type === 'work.read' ||
      command.type === 'work.write' ||
      command.type === 'work.receipt'
    ) {
      const captured = structuredClone(command);
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 36) throw new Error('RUNTIME_TOO_OLD');
      if (!state.work?.available) throw new Error(state.work?.error ?? 'WORK_UNAVAILABLE');
      if (
        state.protocolVersion < 39 &&
        (captured.type === 'work.list'
          ? !isLegacyWorkQuery(captured.query)
          : captured.type !== 'work.read' && !isLegacyWorkWrite(captured.request))
      )
        throw new Error('RUNTIME_TOO_OLD');
      if (captured.type === 'work.list') {
        const value = await this.workApi('/api/work/list', captured.query, state.protocolVersion);
        if (!isWorkList(value) || workQueryKey(value.query) !== workQueryKey(captured.query))
          throw new Error('INVALID_WORK_PAGE');
        return value;
      }
      if (captured.type === 'work.read') {
        const value = await this.workApi(
          '/api/work/read',
          { id: captured.id },
          state.protocolVersion,
        );
        if (!isWorkItem(value) || value.id !== captured.id) throw new Error('INVALID_WORK_ITEM');
        return value;
      }
      const value = await this.workApi(
        captured.type === 'work.write' ? '/api/work/write' : '/api/work/receipt',
        captured.request,
        state.protocolVersion,
      );
      if (
        !isWorkReceipt(value) ||
        value.actor.kind !== 'human' ||
        workKey(value.request, value.actor) !== workKey(captured.request, { kind: 'human' }) ||
        (captured.type === 'work.write' && value.state !== 'complete')
      )
        throw new Error('INVALID_WORK_ACK');
      return value;
    }
    if (command.type === 'group.copy' || command.type === 'group.copy.receipt') {
      // Capture the source and intent before status can yield to another editor or connection update.
      const request = structuredClone(command.request);
      const copying = command.type === 'group.copy';
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 35) throw new Error('RUNTIME_TOO_OLD');
      const value = await this.api(
        `/api/groups/${request.group}/${copying ? 'copy' : 'copy-receipt'}`,
        request,
      );
      if (
        !isGroupCopyReceipt(value) ||
        groupCopyKey(value.request) !== groupCopyKey(request) ||
        (copying && value.state !== 'complete')
      )
        throw new Error('INVALID_GROUP_COPY_ACK');
      return value;
    }
    if (command.type === 'bot.copy' || command.type === 'bot.copy.receipt') {
      // Bind the result to the captured operation, even if the caller changes its form while status awaits.
      const request = structuredClone(command.request);
      const copying = command.type === 'bot.copy';
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 34) throw new Error('RUNTIME_TOO_OLD');
      const value = await this.api(
        `/api/bots/${request.bot}/${copying ? 'copy' : 'copy-receipt'}`,
        request,
      );
      if (
        !isBotCopyReceipt(value) ||
        botCopyKey(value.request) !== botCopyKey(request) ||
        (copying && value.state !== 'complete')
      )
        throw new Error('INVALID_BOT_COPY_ACK');
      return value;
    }
    if (
      command.type === 'transcript.statistics' ||
      command.type === 'transcript.list' ||
      command.type === 'transcript.content'
    ) {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 33) throw new Error('RUNTIME_TOO_OLD');
      const scope = command.query.scope;
      const value: unknown = await this.api(
        `/api/transcripts/${command.type === 'transcript.statistics' ? 'statistics' : command.type === 'transcript.list' ? 'list' : 'content'}`,
        command.query,
      );
      if (command.type === 'transcript.statistics') {
        if (!isRunStatistics(value) || !sameTranscriptScope(value, scope))
          throw new Error('INVALID_STATISTICS');
      } else if (command.type === 'transcript.list') {
        if (
          !isTranscriptPage(value) ||
          !sameTranscriptScope(value, scope) ||
          value.items.some((item) => item.seq <= (command.query.after ?? 0))
        )
          throw new Error('INVALID_TRANSCRIPT_PAGE');
      } else if (
        !isTranscriptContent(value) ||
        !sameTranscriptScope(value, scope) ||
        value.seq !== command.query.seq ||
        value.offset !== (command.query.offset ?? 0)
      )
        throw new Error('INVALID_TRANSCRIPT_CONTENT');
      return value;
    }
    if (
      command.type === 'chat.new' ||
      command.type === 'chat.receipt' ||
      command.type === 'chat.history'
    ) {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 29) throw new Error('RUNTIME_TOO_OLD');
      if (command.type === 'chat.history') {
        if (command.runId && state.protocolVersion < 30) throw new Error('RUNTIME_TOO_OLD');
        const value = await this.api('/api/chats/history', {
          ...(state.model.modelAccess ? { modelAccess: true } : {}),
          bot: command.bot,
          revision: command.revision,
          before: command.before,
          runId: command.runId,
        });
        if (
          !isChatPage(value) ||
          value.bot !== command.bot ||
          value.revision !== command.revision ||
          (command.runId && (value.items.length !== 1 || value.items[0].runId !== command.runId))
        )
          throw new Error('INVALID_CHAT_HISTORY');
        return value;
      }
      const request = command.type === 'chat.new' ? command.request : undefined;
      const bot = request?.bot ?? (command.type === 'chat.receipt' ? command.bot : '');
      const id = request?.id ?? (command.type === 'chat.receipt' ? command.id : '');
      const value = await this.api(
        request ? '/api/chats/new' : '/api/chats/receipt',
        request ?? { bot, id },
      );
      if (
        !isChatAck(value) ||
        value.chat.bot !== bot ||
        value.receipt.request.id !== id ||
        (request && value.receipt.request.revision !== request.revision)
      )
        throw new Error('INVALID_CHAT_ACK');
      return value;
    }
    if (command.type === 'group.action' || command.type === 'group.receipt') {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 28) throw new Error('RUNTIME_TOO_OLD');
      const request = command.type === 'group.action' ? command.request : undefined;
      const group = request?.group ?? (command.type === 'group.receipt' ? command.group : '');
      const id = request?.id ?? (command.type === 'group.receipt' ? command.id : '');
      const value = await this.api(
        request ? '/api/groups/action' : '/api/groups/action-receipt',
        request ?? { group, id },
      );
      if (
        !isGroupActionAck(value) ||
        value.group.id !== group ||
        value.receipt.request.group !== group ||
        value.receipt.request.id !== id ||
        (request &&
          (value.receipt.request.action !== request.action ||
            value.receipt.request.revision !== request.revision))
      )
        throw new Error('INVALID_GROUP_ACTION_ACK');
      return value;
    }
    if (command.type === 'bot.export' || command.type.startsWith('bot.import.')) {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 27) throw new Error('RUNTIME_TOO_OLD');
      if (command.type === 'bot.export') {
        const value = await this.api('/api/bundles/export', command.input);
        if (!isBotBundle(value)) throw new Error('INVALID_BOT_BUNDLE');
        return value;
      }
      let value: unknown, id: string, expected: string | undefined;
      if (command.type === 'bot.import.begin' || command.type === 'bot.import.cancel') {
        id = command.header.id;
        expected = command.header.sha256;
        value = await this.api(
          command.type === 'bot.import.begin' ? '/api/bundles/begin' : '/api/bundles/cancel',
          command.header,
        );
      } else if (command.type === 'bot.import.submit') {
        id = command.id;
        expected = createHash('sha256').update(botBundleText(command.bundle)).digest('hex');
        value = await this.api(`/api/bundles/submit/${encodeURIComponent(id)}`, command.bundle);
      } else if (command.type === 'bot.import.status' || command.type === 'bot.import.retry') {
        id = command.id;
        value =
          command.type === 'bot.import.status'
            ? await this.api(`/api/bundles/status/${encodeURIComponent(id)}`)
            : await this.api('/api/bundles/retry', { id });
      } else throw new Error('INVALID_COMMAND');
      if (
        !isBotImportReceipt(value) ||
        value.id !== id ||
        (expected && value.state !== 'unknown' && value.sha256 !== expected)
      )
        throw new Error('INVALID_BOT_IMPORT_ACK');
      return value;
    }

    if (command.type === 'status' || command.type === 'connect') return this.status();
    if (command.type === 'runtime.inspect') {
      const value = await this.api('/api/diagnostics');
      if (!isDiagnosticReport(value) || value.scope !== 'runtime')
        throw new Error('INVALID_RUNTIME_STATE');
      return value;
    }
    if (command.type.startsWith('mcp.')) {
      if (!isMcpCommand(command)) throw new Error('INVALID_COMMAND');
      const current = await this.status();
      if (current.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (current.protocolVersion < 21) throw new Error('RUNTIME_TOO_OLD');
      if (
        command.bot !== undefined &&
        [
          'mcp.list',
          'mcp.save',
          'mcp.saved',
          'mcp.catalog',
          'mcp.check',
          'mcp.archive',
          'mcp.restore',
        ].includes(command.type) &&
        current.botCapabilities !== true
      )
        throw new Error('RUNTIME_TOO_OLD');
      const value = await this.api(`/api/mcp/${command.type.slice(4)}`, command);
      let valid = false;
      switch (command.type) {
        case 'mcp.list':
          valid =
            isMcpList(value) &&
            value.items.every(
              (entry) =>
                entry.deleted === !!command.includeDeleted &&
                (entry.ownerBot === undefined || entry.ownerBot === command.bot),
            );
          break;
        case 'mcp.save':
          valid =
            isMcpSaved(value) &&
            value.receipt.id === command.input.requestId &&
            (command.bot && command.input.revision === 0
              ? value.current.ownerBot === command.bot
              : value.current.ownerBot === undefined || value.current.ownerBot === command.bot) &&
            value.receipt.connection === command.input.id &&
            value.receipt.revision === command.input.revision + 1 &&
            (value.current.revision !== value.receipt.revision ||
              (!value.current.deleted && value.current.name === command.input.name.trim()));
          break;
        case 'mcp.saved':
          valid =
            isMcpSaved(value) &&
            value.receipt.id === command.id &&
            value.receipt.connection === command.connection &&
            (value.current.ownerBot === undefined || value.current.ownerBot === command.bot);
          break;
        case 'mcp.catalog':
        case 'mcp.check':
          valid =
            isMcpCatalog(value) &&
            value.current.id === command.id &&
            (value.current.ownerBot === undefined || value.current.ownerBot === command.bot) &&
            (command.type !== 'mcp.check' || value.current.revision === command.revision);
          break;
        case 'mcp.bindings':
          valid = isMcpAssignments(value) && value.bot === command.bot;
          break;
        case 'mcp.bind':
          valid =
            isMcpBindingResult(value) &&
            value.bot === command.bot &&
            value.entry.connection.id === command.input.connection &&
            value.entry.connection.revision === command.input.configRevision &&
            value.entry.revision === command.input.bindingRevision + 1 &&
            value.entry.enabled === command.input.enabled &&
            value.entry.catalogDigest === command.input.catalogDigest &&
            value.entry.tools.length === command.input.tools.length &&
            value.entry.tools.every((name) => command.input.tools.includes(name));
          break;
        case 'mcp.archive':
        case 'mcp.restore':
          valid =
            isMcpConnection(value) &&
            value.id === command.id &&
            value.deleted === (command.type === 'mcp.archive') &&
            value.revision >= command.revision &&
            value.revision <= command.revision + 1;
          break;
        case 'mcp.calls':
          valid =
            isMcpHistory(value) &&
            value.bot === command.bot &&
            (!command.connection ||
              value.items.every((entry) => entry.connection === command.connection));
          break;
        case 'mcp.receipt':
          valid =
            isMcpReceipt(value) &&
            value.bot === command.bot &&
            value.run === command.run &&
            value.id === command.id;
          break;
      }
      if (!valid) throw new Error('INVALID_RUNTIME_STATE');
      return value;
    }
    if (
      command.type === 'skill.package.import' ||
      command.type === 'skill.package.update' ||
      command.type === 'skill.package.export' ||
      command.type === 'skill.resource'
    ) {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 40) throw new Error('RUNTIME_TOO_OLD');
      if (
        ['skill.package.import', 'skill.package.update'].includes(command.type) &&
        state.botCapabilities !== true
      )
        throw new Error('RUNTIME_TOO_OLD');
      const action =
        command.type === 'skill.package.import'
          ? 'import-package'
          : command.type === 'skill.package.update'
            ? 'update-package'
            : command.type === 'skill.package.export'
              ? 'export-package'
              : 'resource';
      const { type: _type, ...body } = command,
        value = await this.api(`/api/skills/${action}`, body, true, 40);
      if (command.type === 'skill.resource') {
        if (
          !isSkillResourceData(value) ||
          value.id !== command.id ||
          value.revision !== command.revision ||
          value.file.path !== command.path ||
          createHash('sha256').update(Buffer.from(value.data, 'base64')).digest('hex') !==
            value.file.sha256
        )
          throw new Error('INVALID_RUNTIME_STATE');
        return value;
      }
      if (command.type === 'skill.package.export') {
        if (
          !isSkillArchiveResult(value) ||
          value.id !== command.id ||
          value.revision !== command.revision ||
          createHash('sha256').update(Buffer.from(value.archive.data, 'base64')).digest('hex') !==
            value.archive.sha256
        )
          throw new Error('INVALID_RUNTIME_STATE');
        return value.archive;
      }
      const preview = inspectSkillPackage(command.package);
      if (
        !isSkillDocument(value) ||
        value.deleted ||
        value.package?.digest !== preview.digest ||
        (value.ownerBot !== undefined && value.ownerBot !== command.bot) ||
        (command.type === 'skill.package.import' && value.ownerBot !== command.bot) ||
        ('id' in command &&
          (value.id !== command.id ||
            value.revision < command.revision ||
            value.revision > command.revision + 1))
      )
        throw new Error('INVALID_RUNTIME_STATE');
      return value;
    }
    if (
      command.type === 'skill.list' ||
      command.type === 'skill.read' ||
      command.type === 'skill.import' ||
      command.type === 'skill.update' ||
      command.type === 'skill.recycle' ||
      command.type === 'skill.restore' ||
      command.type === 'skill.bind' ||
      command.type === 'skill.copy'
    ) {
      const current = await this.status();
      if (current.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (current.protocolVersion < 20) throw new Error('RUNTIME_TOO_OLD');
      if (
        !['skill.list', 'skill.read', 'skill.bind'].includes(command.type) &&
        current.botCapabilities !== true
      )
        throw new Error('RUNTIME_TOO_OLD');
      const { type, ...request } = command;
      const value = await this.api(`/api/skills/${type.slice('skill.'.length)}`, request);
      if (command.type === 'skill.copy') {
        if (!isSkillDocument(value) || (!value.system && value.ownerBot !== command.targetBot))
          throw new Error('INVALID_RUNTIME_STATE');
        return value;
      }
      if (command.type === 'skill.list') {
        if (
          !isSkillCatalogResult(value) ||
          value.bot !== command.bot ||
          !value.catalog.items.every(
            (item) => item.ownerBot === undefined || item.ownerBot === command.bot,
          )
        )
          throw new Error('INVALID_RUNTIME_STATE');
        return value.catalog;
      }
      if (command.type === 'skill.bind') {
        if (!isSkillBindingResult(value) || value.bot !== command.bot)
          throw new Error('INVALID_RUNTIME_STATE');
        const entry = value.entry;
        if (
          entry.id !== command.binding.id ||
          entry.revision !== command.binding.revision ||
          entry.enabled !== command.binding.enabled ||
          entry.deleted ||
          entry.bindingRevision < command.binding.bindingRevision ||
          entry.bindingRevision > command.binding.bindingRevision + 1
        )
          throw new Error('INVALID_RUNTIME_STATE');
        return entry;
      }
      if (
        !isSkillDocument(value) ||
        ('id' in command && value.id !== command.id) ||
        (value.ownerBot !== undefined && value.ownerBot !== command.bot) ||
        (command.type === 'skill.import' && value.ownerBot !== command.bot) ||
        ((command.type === 'skill.import' || command.type === 'skill.update') &&
          (value.content !== command.content || value.deleted)) ||
        ('revision' in command &&
          (value.revision < command.revision || value.revision > command.revision + 1)) ||
        (command.type === 'skill.recycle' && !value.deleted) ||
        (command.type === 'skill.restore' && value.deleted)
      )
        throw new Error('INVALID_RUNTIME_STATE');
      return value;
    }
    if (command.type === 'bot.action' || command.type === 'bot.receipt') {
      const current = await this.status();
      if (current.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (current.protocolVersion < 22) throw new Error('RUNTIME_TOO_OLD');
      const mutation = command.type === 'bot.action';
      const bot = mutation ? command.request.bot : command.bot;
      const id = mutation ? command.request.id : command.id;
      const value = await this.api(
        `/api/bots/${bot}/${mutation ? 'lifecycle' : 'lifecycle-receipt'}`,
        mutation ? command.request : { id },
      );
      if (
        !isBotLifecycleAck(value) ||
        value.receipt.bot !== bot ||
        value.receipt.id !== id ||
        (command.type === 'bot.action' &&
          (value.receipt.action !== command.request.action ||
            value.receipt.baseRevision !== command.request.revision ||
            value.receipt.phase !== 'complete'))
      )
        throw new Error('INVALID_RUNTIME_STATE');
      return value;
    }
    if (command.type === 'computer.action' || command.type === 'computer.receipt') {
      const current = await this.status();
      if (current.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (current.protocolVersion < 19) throw new Error('RUNTIME_TOO_OLD');
      const expected = command.type === 'computer.action' ? command.request : command;
      const result = await this.api(
        command.type === 'computer.action' ? '/api/computers/action' : '/api/computers/receipt',
        command.type === 'computer.action' ? command.request : { id: command.id, bot: command.bot },
      );
      if (
        !isComputerAck(result) ||
        result.receipt.id !== expected.id ||
        result.receipt.bot !== expected.bot ||
        result.state.bot !== expected.bot
      )
        throw new Error('INVALID_RUNTIME_STATE');
      return result;
    }
    if (command.type.startsWith('browser.')) {
      const current = await this.status();
      if (current.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (current.protocolVersion < 16) throw new Error('RUNTIME_TOO_OLD');
      const owned = (value: unknown) => {
        if (!isBrowserState(value) || !('bot' in command) || value.bot !== command.bot)
          throw new Error('INVALID_RUNTIME_STATE');
        return value;
      };
      if (command.type === 'browser.state')
        return owned(await this.api(`/api/bots/${command.bot}/browser-state`));
      if (command.type === 'browser.view') {
        const result = await this.api(`/api/bots/${command.bot}/browser-view`);
        if (!isBrowserView(result) || result.bot !== command.bot)
          throw new Error('INVALID_RUNTIME_STATE');
        return result;
      }
      if (command.type === 'browser.command' || command.type === 'browser.answer') {
        const { type: _type, bot, ...request } = command;
        const result = await this.api(
          `/api/bots/${bot}/${command.type === 'browser.command' ? 'browser-command' : 'browser-answer'}`,
          request,
        );
        if (!isBrowserAck(result) || result.id !== command.id)
          throw new Error('INVALID_RUNTIME_STATE');
        owned(result.state);
        return result;
      }
      if (command.type === 'browser.receipt') {
        const result = await this.api(`/api/bots/${command.bot}/browser-receipt`, {
          id: command.id,
        });
        if (!isBrowserReceipt(result) || result.id !== command.id || result.bot !== command.bot)
          throw new Error('INVALID_RUNTIME_STATE');
        return result;
      }
      if (command.type === 'browser.input')
        return this.api(`/api/bots/${command.bot}/browser-bound-input`, {
          epoch: command.epoch,
          binding: command.binding,
          input: command.input,
        });
    }
    if (
      command.type === 'group.register' ||
      command.type === 'group.update' ||
      command.type === 'group.read' ||
      command.type === 'group.input' ||
      command.type === 'group.send' ||
      command.type === 'group.cancel'
    ) {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 15) throw new Error('RUNTIME_TOO_OLD');
      const action = command.type.split('.')[1];
      const payload =
        command.type === 'group.register'
          ? command.group
          : command.type === 'group.send'
            ? command.input
            : command.type === 'group.update'
              ? { group: command.group, revision: command.revision, input: command.input }
              : command.type === 'group.read'
                ? { group: command.group, before: command.before }
                : command.type === 'group.input'
                  ? { group: command.group, sourceId: command.sourceId, name: command.name }
                  : { group: command.group, sourceId: command.sourceId };
      const result = await this.api(`/api/groups/${action}`, payload);
      const id =
        command.type === 'group.register'
          ? command.group.id
          : command.type === 'group.send'
            ? command.input.group
            : command.group;
      if (command.type === 'group.input') {
        const value = result as { group?: unknown; sourceId?: unknown; file?: unknown };
        if (
          !value ||
          value.group !== id ||
          value.sourceId !== command.sourceId ||
          !isTaskFile(value.file) ||
          value.file.name !== command.name
        )
          throw new Error('INVALID_RUNTIME_STATE');
      } else if (command.type === 'group.register' || command.type === 'group.update') {
        if (!isGroup(result) || result.id !== id) throw new Error('INVALID_RUNTIME_STATE');
        if (
          command.type === 'group.update' &&
          (result.name !== command.input.name.trim() ||
            JSON.stringify(result.members) !== JSON.stringify(command.input.members))
        )
          throw new Error('INVALID_RUNTIME_STATE');
      } else {
        if (!isGroupPage(result) || result.group.id !== id)
          throw new Error('INVALID_RUNTIME_STATE');
        if (
          command.type === 'group.send' &&
          (result.accepted?.id !== command.input.id ||
            result.accepted.text !== command.input.prompt)
        )
          throw new Error('INVALID_RUNTIME_STATE');
        if (command.type === 'group.cancel' && result.cancelledSource !== command.sourceId)
          throw new Error('INVALID_RUNTIME_STATE');
      }
      return result;
    }
    if (
      command.type === 'model.saved' ||
      command.type === 'model.fallback.configure' ||
      command.type === 'model.remove' ||
      command.type === 'model.diagnose'
    ) {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (!state.model.modelAccess) throw new Error('RUNTIME_TOO_OLD');
      if (state.model.modelAccess.scope !== command.input.scope)
        throw new Error('RUNTIME_SESSION_CHANGED');
      const route =
        command.type === 'model.fallback.configure'
          ? 'fallback'
          : command.type.slice('model.'.length);
      const value = await this.api(`/api/model/${route}`, command.input);
      if (command.type === 'model.fallback.configure') {
        if (
          !isModelStatus(value) ||
          value.requestId !== command.input.requestId ||
          value.revision !== command.input.revision + 1 ||
          value.fallbackModel !== (command.input.model || undefined)
        )
          throw new Error('INVALID_RUNTIME_STATE');
      } else {
        if (
          !isModelSaved(value) ||
          value.scope !== command.input.scope ||
          value.requestId !== command.input.requestId ||
          value.revision !== command.input.revision
        )
          throw new Error('INVALID_RUNTIME_STATE');
        if (
          command.type === 'model.saved' &&
          (value.connection !== command.input.connection || value.model !== command.input.model)
        )
          throw new Error('INVALID_RUNTIME_STATE');
        if (
          command.type === 'model.remove' &&
          (value.kind !== 'remove' || value.connection !== command.input.connection)
        )
          throw new Error('INVALID_RUNTIME_STATE');
        if (
          command.type === 'model.diagnose' &&
          (value.kind !== 'diagnose' ||
            value.connection !== command.input.connection.id ||
            value.model !== diagnosticModel(command.input))
        )
          throw new Error('INVALID_RUNTIME_STATE');
      }
      return value;
    }
    if (command.type === 'model.inspect') {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.model.inspection !== true) throw new Error('RUNTIME_TOO_OLD');
      const value = await this.api('/api/model/inspect', command.input);
      if (
        !isModelInspection(value) ||
        value.kind !== command.input.kind ||
        value.revision !== command.input.revision ||
        (value.kind === 'test' && value.model !== command.input.model) ||
        ((value.kind === 'limits' || value.kind === 'metadata') &&
          value.model.id !== command.input.model)
      )
        throw new Error('INVALID_RUNTIME_STATE');
      return value;
    }
    if (command.type === 'model.configure' || command.type === 'model.check') {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 13) throw new Error('RUNTIME_TOO_OLD');
      const value = await this.api(
        `/api/model/${command.type.split('.')[1]}`,
        command.type === 'model.configure' ? command.input : { revision: command.revision },
      );
      if (command.type === 'model.configure') {
        if (
          !isModelStatus(value) ||
          !value.configured ||
          value.requestId !== command.input.requestId ||
          value.model !== command.input.model ||
          value.revision !== command.input.revision + 1
        )
          throw new Error('INVALID_RUNTIME_STATE');
      } else if (
        !isModelCheck(value) ||
        value.revision !== command.revision ||
        value.model !== state.model.model
      )
        throw new Error('INVALID_RUNTIME_STATE');
      return value;
    }
    if (
      command.type === 'attachment.list' ||
      command.type === 'attachment.trash' ||
      command.type === 'attachment.restore' ||
      command.type === 'attachment.purge'
    ) {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 12) throw new Error('RUNTIME_TOO_OLD');
      const { type, ...payload } = command;
      const result = await this.api(`/api/attachments/${type.split('.')[1]}`, payload);
      if (command.type === 'attachment.list') {
        if (
          !isAttachmentPage(result) ||
          !result.items.every(
            (entry, index) =>
              entry.bot === command.bot &&
              entry.deleted === !!command.query.trash &&
              entry.id > (index ? result.items[index - 1].id : command.query.before || '') &&
              entry.id ===
                createHash('sha256').update(`${entry.name}\0${entry.sha256}`).digest('hex'),
          )
        )
          throw new Error('INVALID_RUNTIME_STATE');
      } else if (command.type === 'attachment.purge') {
        if (
          !isAttachmentPurge(result) ||
          result.bot !== command.bot ||
          result.id !== command.id ||
          result.version !== command.version
        )
          throw new Error('INVALID_RUNTIME_STATE');
      } else if (
        !isAttachmentEntry(result) ||
        result.bot !== command.bot ||
        result.id !== command.id ||
        result.deleted !== (command.type === 'attachment.trash') ||
        result.id !== createHash('sha256').update(`${result.name}\0${result.sha256}`).digest('hex')
      )
        throw new Error('INVALID_RUNTIME_STATE');
      return result;
    }
    if (
      command.type === 'attachment.upload' ||
      command.type === 'attachment.source' ||
      command.type === 'attachment.read'
    ) {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 11) throw new Error('RUNTIME_TOO_OLD');
      if (
        command.type === 'attachment.upload' &&
        state.protocolVersion < (imageProtocol(command.file.name) ?? 11)
      )
        throw new Error('ATTACHMENT_RUNTIME_TOO_OLD');
      const { type, ...payload } = command;
      const result = await this.api(`/api/attachments/${type.split('.')[1]}`, payload);
      if (command.type === 'attachment.upload') {
        const data = Buffer.from(command.file.data, 'base64'),
          sha256 = createHash('sha256').update(data).digest('hex');
        if (
          !isAttachmentReceipt(result) ||
          result.bot !== command.bot ||
          result.name !== command.file.name ||
          result.size !== data.length ||
          result.sha256 !== sha256 ||
          result.id !== createHash('sha256').update(`${command.file.name}\0${sha256}`).digest('hex')
        )
          throw new Error('INVALID_RUNTIME_STATE');
      } else if (command.type === 'attachment.read') {
        if (
          !isAttachmentReceipt(result) ||
          result.bot !== command.bot ||
          result.id !== command.id ||
          result.id !==
            createHash('sha256').update(`${result.name}\0${result.sha256}`).digest('hex')
        )
          throw new Error('INVALID_RUNTIME_STATE');
      } else if (
        !isAttachmentOriginal(result) ||
        result.bot !== command.bot ||
        result.id !== command.id ||
        Buffer.from(result.file.data, 'base64').toString('base64') !== result.file.data ||
        createHash('sha256').update(Buffer.from(result.file.data, 'base64')).digest('hex') !==
          result.sha256
      )
        throw new Error('INVALID_RUNTIME_STATE');
      return result;
    }
    if (
      command.type === 'knowledge.list' ||
      command.type === 'knowledge.read' ||
      command.type === 'knowledge.write' ||
      command.type === 'knowledge.import' ||
      command.type === 'knowledge.source' ||
      command.type === 'knowledge.remove' ||
      command.type === 'knowledge.versions' ||
      command.type === 'knowledge.restore'
    ) {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 9) throw new Error('RUNTIME_TOO_OLD');
      if (
        ['knowledge.import', 'knowledge.source'].includes(command.type) &&
        state.protocolVersion < 10
      )
        throw new Error('RUNTIME_TOO_OLD');
      const { type, ...payload } = command;
      const result = await this.api(`/api/knowledge/${type.slice('knowledge.'.length)}`, payload);
      if (type === 'knowledge.source') {
        if (
          !isDocumentOriginal(result) ||
          result.bot !== command.bot ||
          result.id !== command.id ||
          Buffer.from(result.file.data, 'base64').toString('base64') !== result.file.data ||
          createHash('sha256').update(Buffer.from(result.file.data, 'base64')).digest('hex') !==
            result.sha256
        )
          throw new Error('INVALID_RUNTIME_STATE');
      } else if (type === 'knowledge.list') {
        if (
          !Array.isArray(result) ||
          !result.every((file) => isKnowledgeFile(file) && file.bot === command.bot)
        )
          throw new Error('INVALID_RUNTIME_STATE');
      } else if (type === 'knowledge.versions') {
        if (!Array.isArray(result) || result.length > 20 || !result.every(isKnowledgeVersion))
          throw new Error('INVALID_RUNTIME_STATE');
      } else {
        if (
          !isKnowledgeDocument(result) ||
          result.bot !== command.bot ||
          ('id' in command && result.id !== command.id)
        )
          throw new Error('INVALID_RUNTIME_STATE');
        if (
          type === 'knowledge.write' &&
          (result.path !== command.document.path ||
            (command.document.id !== undefined && result.id !== command.document.id))
        )
          throw new Error('INVALID_RUNTIME_STATE');
        if (
          type === 'knowledge.read' &&
          command.version !== undefined &&
          result.revision !== command.version
        )
          throw new Error('INVALID_RUNTIME_STATE');
        if (type === 'knowledge.remove' && !result.deleted)
          throw new Error('INVALID_RUNTIME_STATE');
        if (
          type === 'knowledge.import' &&
          (!result.source ||
            result.source.name !== command.file.name ||
            result.source.size !== Buffer.from(command.file.data, 'base64').length ||
            result.source.sha256 !==
              createHash('sha256').update(Buffer.from(command.file.data, 'base64')).digest('hex'))
        )
          throw new Error('INVALID_RUNTIME_STATE');
      }
      return result;
    }
    if (
      command.type === 'schedule.get' ||
      command.type === 'schedule.create' ||
      command.type === 'schedule.update' ||
      command.type === 'schedule.preview' ||
      command.type === 'schedule.remove' ||
      command.type === 'schedule.run'
    ) {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 5) throw new Error('RUNTIME_TOO_OLD');
      if (
        state.protocolVersion < 6 &&
        ((command.type === 'schedule.update' && command.patch.locked !== undefined) ||
          (command.type === 'schedule.create' && command.input.locked !== undefined))
      )
        throw new Error('RUNTIME_TOO_OLD');
      const { type, ...payload } = command;
      const result = await this.api(
        `/api/schedules/${type.slice('schedule.'.length)}`,
        type === 'schedule.create' ? command.input : payload,
      );
      if (
        (type === 'schedule.get' || type === 'schedule.create' || type === 'schedule.update') &&
        !isSchedule(result)
      )
        throw new Error('INVALID_RUNTIME_STATE');
      if (
        (type === 'schedule.get' || type === 'schedule.update') &&
        isSchedule(result) &&
        result.id !== command.id
      )
        throw new Error('INVALID_RUNTIME_STATE');
      if (
        type === 'schedule.create' &&
        isSchedule(result) &&
        (result.id !== command.input.id || result.bot !== command.input.bot)
      )
        throw new Error('INVALID_RUNTIME_STATE');
      if (
        type === 'schedule.preview' &&
        (!Array.isArray(result) ||
          !result.length ||
          result.length > 3 ||
          !result.every((time) => typeof time === 'string' && Number.isFinite(Date.parse(time))))
      )
        throw new Error('INVALID_RUNTIME_STATE');
      if (type === 'schedule.run' && !isScheduleFiring(result))
        throw new Error('INVALID_RUNTIME_STATE');
      if (
        type === 'schedule.remove' &&
        (!result ||
          typeof result !== 'object' ||
          !('id' in result) ||
          result.id !== command.id ||
          !('removed' in result) ||
          result.removed !== true)
      )
        throw new Error('INVALID_RUNTIME_STATE');
      return result;
    }
    if (command.type === 'interaction.reply') {
      const current = await this.status();
      if (current.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (current.protocolVersion < 4) throw new Error('RUNTIME_TOO_OLD');
      const reply = await this.api(`/api/bots/${command.bot}/reply`, {
        id: command.id,
        runId: command.runId,
        reply: command.reply,
      });
      if (
        !isInteraction(reply) ||
        reply.id !== command.id ||
        reply.bot !== command.bot ||
        reply.runId !== command.runId
      )
        throw new Error('INVALID_RUNTIME_STATE');
      return reply;
    }
    if (command.type === 'memory.history') {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 32) throw new Error('RUNTIME_TOO_OLD');
      const value = await this.api('/api/memory/history', {
        bot: command.bot,
        query: command.query,
      });
      if (
        !isMemoryPage(value) ||
        value.bot !== command.bot ||
        (command.query.before === undefined
          ? !value.items.length || value.items[0].revision !== value.currentRevision
          : value.items.some((item) => item.revision >= command.query.before!))
      )
        throw new Error('INVALID_MEMORY_HISTORY');
      return value;
    }
    if (command.type === 'bot.register' || command.type === 'bot.update') {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 3) throw new Error('RUNTIME_TOO_OLD');
      if (
        command.type === 'bot.register' &&
        command.profile.kind === 'chat' &&
        state.protocolVersion < 46
      )
        throw new Error('RUNTIME_TOO_OLD');
      if (
        state.protocolVersion < 14 &&
        (command.type === 'bot.register'
          ? command.profile.model !== undefined
          : Object.hasOwn(command.patch, 'model'))
      )
        throw new Error('RUNTIME_TOO_OLD');
      const profile = await (command.type === 'bot.register'
        ? this.api('/api/bots', command.profile)
        : this.api(`/api/bots/${command.bot}/profile`, {
            revision: command.revision,
            patch: command.patch,
          }));
      if (
        !isBotProfile(profile) ||
        profile.id !== (command.type === 'bot.register' ? command.profile.id : command.bot)
      )
        throw new Error('INVALID_RUNTIME_STATE');
      if (
        command.type === 'bot.update' &&
        Object.hasOwn(command.patch, 'model') &&
        profile.model !== (command.patch.model ?? undefined)
      )
        throw new Error('INVALID_RUNTIME_STATE');
      return profile;
    }
    if (command.type === 'files.list') return this.api('/api/files') as Promise<RuntimeFile[]>;
    if (command.type === 'files.read') return this.api('/api/files/read', { path: command.path });
    if (command.type === 'files.download') {
      const state = await this.status();
      if (state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 11) throw new Error('RUNTIME_TOO_OLD');
      const result = await this.api('/api/files/download', { path: command.path });
      if (
        !isRuntimeDownload(result) ||
        result.path !== command.path ||
        Buffer.from(result.data, 'base64').toString('base64') !== result.data ||
        createHash('sha256').update(Buffer.from(result.data, 'base64')).digest('hex') !==
          result.sha256
      )
        throw new Error('INVALID_RUNTIME_STATE');
      return result;
    }
    const route = `/api/bots/${'bot' in command ? command.bot : ''}`;
    switch (command.type) {
      case 'task.start': {
        const current = await this.status();
        if (current.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
        if (command.task.retryTurn !== undefined && current.protocolVersion < 43)
          throw new Error('RUNTIME_TOO_OLD');
        if (command.task.approvalMode !== undefined && current.protocolVersion < 44)
          throw new Error('RUNTIME_TOO_OLD');
        if (
          (command.task.contextRevision !== undefined || command.task.model !== undefined) &&
          current.protocolVersion < 46
        )
          throw new Error('RUNTIME_TOO_OLD');
        if (
          current.protocolVersion < 11 &&
          command.task.files?.some((file) => file.attachmentId !== undefined)
        )
          throw new Error('RUNTIME_TOO_OLD');
        if (
          current.protocolVersion < 1 ||
          (current.protocolVersion < 2 && !['a', 'b'].includes(command.bot))
        )
          throw new Error('RUNTIME_TOO_OLD');
        const value: unknown = await this.api(`${route}/model`, {
          running: true,
          task: command.task,
        });
        if (current.protocolVersion < 29) return value;
        if (!value || typeof value !== 'object' || Array.isArray(value))
          throw new Error('INVALID_TASK_ACK');
        const raw = value as Record<string, unknown>;
        const receipt = {
          runId: raw.runId,
          requestId: raw.requestId,
          prompt: raw.prompt,
          phase: raw.phase,
          running: raw.running,
          result: raw.result,
          error: raw.error,
          ...(raw.chatRevision === undefined ? {} : { chatRevision: raw.chatRevision }),
          ...(raw.files === undefined ? {} : { files: raw.files }),
          ...(raw.response === undefined ? {} : { response: raw.response }),
        };
        if (
          !isTaskReceipt(receipt) ||
          raw.conversationId !== undefined ||
          receipt.requestId !== command.task.requestId ||
          receipt.prompt !== command.task.prompt ||
          (receipt.chatRevision ?? 0) !==
            (command.task.contextRevision ?? command.task.chatRevision ?? 0)
        )
          throw new Error('INVALID_TASK_ACK');
        return receipt;
      }
      case 'task.stop':
        return this.api(`${route}/model`, { running: false });
      case 'task.insert': {
        const current = await this.status();
        if (current.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
        if (current.protocolVersion < 42) throw new Error('RUNTIME_TOO_OLD');
        const value: unknown = await this.api(`${route}/insert`, {
          id: command.id,
          text: command.text,
          runId: command.runId,
          chatRevision: command.chatRevision,
        });
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          (value as Record<string, unknown>).ok !== true ||
          (value as Record<string, unknown>).id !== command.id
        )
          throw new Error('INVALID_TASK_ACK');
        return value;
      }
      case 'control':
        return this.api(`${route}/control`, {
          epoch: command.epoch,
          owner: command.owner,
          instance: command.instance,
        });
      case 'input':
        return this.api(`${route}/input`, {
          epoch: command.epoch,
          input: command.input,
          instance: command.instance,
        });
      case 'app':
        return this.api(`${route}/app`, {
          epoch: command.epoch,
          app: command.app,
          instance: command.instance,
        });
      case 'frame':
        return this.api(
          route +
            (command.surface === 'desktop' ? '/frame' : '/browser-frame') +
            (command.instance === undefined
              ? ''
              : `?${new URLSearchParams({ instance: command.instance, epoch: String(command.epoch) })}`),
        );
    }
  }
  async releaseInputs() {
    const snapshot = await this.status();
    for (const [bot, state] of Object.entries(snapshot.bots)) {
      if (state?.owner === 'human')
        await this.invoke({
          type: 'input',
          bot,
          epoch: state.epoch,
          instance: state.instance,
          input: { type: 'release' },
        });
    }
  }
}
