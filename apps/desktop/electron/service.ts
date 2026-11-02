import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { secureDirectory } from '@daban/engine/local-computer';
import {
  type DiagnosticReport,
  diagnosticIds,
  disconnected,
  isLocalComputerCommand,
  isRebootStatus,
  modelCatalog,
  modelHasVision,
  type RebootStatus,
  type RuntimeCommand,
  type RuntimeReply,
  type RuntimeSnapshot,
  recoveryBlocked,
  recoveryReader,
  type SetupStatus,
} from '@daban/protocol';
import { BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { AgentSetup } from './agent-setup';
import { Daemon, daemonScope } from './daemon';
import { loadHost, type ManagedHost } from './host';
import { parseCommand, trustedSender } from './ipc';
import type { LocalComputer } from './local-computer';
import { NativeDaemon } from './native-daemon';
import { RuntimeClient } from './runtime';
import { Setup } from './setup';
import { pickSkill } from './skill-picker';
import { controlSocket } from './socket';
import { readAgentToken, unixFetch } from './unix';

export interface AgentConfig {
  entry: string;
  executable: string;
  dataRoot?: string;
  socketPath?: string;
  vmConfig?: string;
}

export function runtimeService(
  userData: string,
  rendererUrl: string,
  resources = join(__dirname, '..', 'resources/environment'),
  onSnapshot?: (snapshot: RuntimeSnapshot, scope?: string) => Promise<unknown>,
  agent?: AgentConfig,
  local?: LocalComputer,
) {
  const dataRoot = agent?.dataRoot ?? join(userData, 'agent');
  const vmConfig = agent?.vmConfig ?? join(userData, 'runtime.json');
  const agentScope = agent ? daemonScope(dataRoot, vmConfig) : undefined;
  const agentConfig = agent
    ? {
        entry: agent.entry,
        executable: agent.executable,
        dataRoot,
        vmConfig,
        socketPath: agent.socketPath ?? controlSocket(join(userData, 'agent.sock'), agentScope!),
      }
    : undefined;
  let daemon: Daemon | NativeDaemon | undefined;
  const nativeMode = !!agentConfig && process.platform === 'win32';
  const agentTransport = new AbortController();
  let setup: Setup | AgentSetup | undefined;
  let setupState: SetupStatus | undefined;
  function installation() {
    if (closed) throw new Error('RUNTIME_CLOSED');
    const onChange = (next: SetupStatus) => {
      if (closed) return;
      setupState = next;
      publish(state);
      if (next.phase === 'complete')
        connect().catch(() => console.error('Installed runtime connection failed'));
    };
    setup ??= agentConfig
      ? new AgentSetup({ config: agentConfig, onChange })
      : new Setup({ userData, resources, onChange });
    return setup;
  }
  let host: ManagedHost | undefined;
  let loadingHost: Promise<ManagedHost> | undefined;
  let client: RuntimeClient | undefined;
  let state: RuntimeSnapshot = disconnected('connecting');
  let reboot: RebootStatus | undefined;
  let rebootRequested = 0,
    rebootPublished = 0;
  let recovering = false;
  let connecting: Promise<RuntimeSnapshot> | undefined;
  let polling = false;
  let closed = false;
  let connection = 0;
  let requested = 0,
    published = 0,
    lastPoll = 0;
  async function managed() {
    if (closed) throw new Error('RUNTIME_CLOSED');
    if (agentConfig) throw new Error('AGENT_CONTROL_ONLY');
    if (host) return host;
    loadingHost ??= loadHost(join(userData, 'runtime.json'), join(userData, 'runtime-tunnel.sock'))
      .then(async (loaded) => {
        // Closing during config IO must not let a late owner start the VM after Electron has quit.
        if (closed) {
          await loaded.close();
          throw new Error('RUNTIME_CLOSED');
        }
        host = loaded;
        return loaded;
      })
      .finally(() => {
        loadingHost = undefined;
      });
    return loadingHost;
  }
  function privateClient() {
    if (!agentConfig) throw new Error('AGENT_NOT_CONFIGURED');
    const fetcher = unixFetch(agentConfig.socketPath, {
      certificateFile: join(agentConfig.dataRoot, 'model/control-certificate.pem'),
    });
    return new RuntimeClient({
      origin: 'http://127.0.0.1:8766',
      agent: true,
      tokenProvider: () => readAgentToken(agentConfig.dataRoot),
      fetcher: (url, init = {}) =>
        fetcher(url, {
          ...init,
          signal: AbortSignal.any([agentTransport.signal, ...(init.signal ? [init.signal] : [])]),
        }),
    });
  }
  async function connectAgent() {
    if (!agentConfig) throw new Error('AGENT_NOT_CONFIGURED');
    if (nativeMode) {
      await secureDirectory(agentConfig.dataRoot);
      const native = daemon instanceof NativeDaemon ? daemon : new NativeDaemon(agentConfig);
      daemon = native;
      return native.ensure();
    }
    // A partial configuration does not clear a user pause or authorize a legacy VM installation.
    const progress = await installation().status();
    if (progress.required) {
      setupState = progress;
      throw new Error('SETUP_REQUIRED');
    }
    await access(agentConfig.vmConfig);
    if (closed) throw new Error('RUNTIME_CLOSED');
    daemon ??= new Daemon(agentConfig);
    await daemon.ensure();
    if (closed) throw new Error('RUNTIME_CLOSED');
    return privateClient();
  }
  async function inspectAgent(): Promise<DiagnosticReport> {
    const report: DiagnosticReport = {
      scope: 'host',
      checkedAt: new Date().toISOString(),
      checks: [...diagnosticIds.host, ...diagnosticIds.runtime].map((id) => ({
        id,
        state: 'unchecked',
      })),
    };
    const configuration = report.checks.find((row) => row.id === 'configuration')!;
    try {
      await access(vmConfig);
      configuration.state = 'ready';
    } catch (error) {
      configuration.state =
        error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
          ? 'unconfigured'
          : 'unavailable';
      return report;
    }
    if (closed) throw new Error('RUNTIME_CLOSED');
    try {
      // Inspection attaches only to an existing private service; it must not start a daemon or VM.
      if (!agentConfig) throw new Error('AGENT_NOT_CONFIGURED');
      const response = await unixFetch(agentConfig.socketPath, { maxBytes: 64 * 1024 })(
        'http://127.0.0.1:8766/agent/identity',
        { signal: AbortSignal.any([agentTransport.signal, AbortSignal.timeout(2000)]) },
      );
      const identity: unknown = await response.json();
      if (
        !response.ok ||
        !identity ||
        typeof identity !== 'object' ||
        !('role' in identity) ||
        identity.role !== 'agent' ||
        !('scope' in identity) ||
        identity.scope !== agentScope ||
        !('dataRoot' in identity) ||
        identity.dataRoot !== agentConfig.dataRoot ||
        !('socketPath' in identity) ||
        identity.socketPath !== agentConfig.socketPath
      )
        throw new Error('AGENT_DAEMON_SCOPE_MISMATCH');
      if (closed) throw new Error('RUNTIME_CLOSED');
      const value = (await (client ?? privateClient()).invoke({
        type: 'runtime.inspect',
      })) as DiagnosticReport;
      report.checks.splice(
        diagnosticIds.host.length,
        diagnosticIds.runtime.length,
        ...value.checks,
      );
    } catch {
      if (closed) throw new Error('RUNTIME_CLOSED');
      report.checks.find((row) => row.id === 'agent')!.state = 'unavailable';
    }
    return report;
  }
  function publish(next: RuntimeSnapshot) {
    if (closed) return;
    if (reboot) next = { ...next, reboot };
    if (setupState) next = { ...next, setup: setupState };
    const changed = JSON.stringify(state) !== JSON.stringify(next);
    state = next;
    if (changed && onSnapshot) {
      const scope =
        agentScope ??
        (host?.config
          ? createHash('sha256')
              .update(JSON.stringify([host.config.limaHome, host.config.vm]))
              .digest('hex')
          : undefined);
      try {
        onSnapshot(state, scope).catch(() => console.error('Desktop notice observation failed'));
      } catch {
        console.error('Desktop notice observation failed');
      }
    }
    if (changed)
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('daban:runtime-state', state);
  }
  function acceptReboot(next: RebootStatus, ticket = ++rebootRequested) {
    // Network status replies started before a new power intent must never clear its effect fence.
    if (ticket < rebootPublished) return false;
    const changed = JSON.stringify(next) !== JSON.stringify(reboot);
    rebootPublished = ticket;
    reboot = next;
    return changed;
  }
  async function refreshReboot() {
    const ticket = ++rebootRequested,
      epoch = connection,
      current = client;
    let next: RebootStatus;
    if (agentConfig) {
      if (!client) return;
      try {
        const value = await client.invoke({ type: 'recovery.status' });
        if (!isRebootStatus(value)) throw new Error('INVALID_RUNTIME_STATE');
        next = value;
      } catch {
        next = { available: false, error: 'RECOVERY_HOST_STORE_UNAVAILABLE' };
      }
    } else {
      if (!host) return;
      next = await host.recoveryStatus();
    }
    if (epoch !== connection || (agentConfig && current !== client)) return;
    if (acceptReboot(next, ticket)) publish(state);
  }
  async function refresh() {
    if (!client) return state;
    const current = client,
      ticket = ++requested;
    const powerTicket = agentConfig ? ++rebootRequested : undefined;
    const next = await current.status();
    // A slow poll started before a mutation/reconnect cannot roll back its newer snapshot.
    if (current === client && ticket >= published) {
      published = ticket;
      if (agentConfig && next.reboot) acceptReboot(next.reboot, powerTicket);
      publish(next);
    }
    return state;
  }
  async function connect(): Promise<RuntimeSnapshot> {
    if (connecting) return connecting;
    connecting = (async () => {
      connection++;
      rebootPublished = ++rebootRequested;
      published = ++requested;
      publish(disconnected('connecting'));
      try {
        if (agentConfig) client = await connectAgent();
        else {
          const owner = await managed();
          await refreshReboot();
          client = await owner.connect();
        }
        await refresh();
      } catch (error) {
        if (agentConfig) client = undefined;
        if (nativeMode) {
          publish(disconnected('offline', 'errors.runtimeConnectionUnavailable'));
          return state;
        }
        if (
          (error instanceof Error && error.message === 'SETUP_REQUIRED') ||
          (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        )
          setupState = await installation().status();
        publish(disconnected('offline', '本地运行环境未连接，请在设置中重试。'));
      }
      return state;
    })().finally(() => {
      connecting = undefined;
    });
    return connecting;
  }
  async function dispatch(command: RuntimeCommand): Promise<unknown> {
    if (command.type === 'skill.pick') {
      if (closed || !client || state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (state.protocolVersion < 40) throw new Error('RUNTIME_TOO_OLD');
      const owner = client,
        epoch = connection;
      const selected = await pickSkill(command.kind, agentTransport.signal);
      if (closed || client !== owner || connection !== epoch) throw new Error('RUNTIME_OFFLINE');
      const current = await owner.status(),
        profile = current.profiles.find((item) => item.id === command.bot);
      if (!profile || profile.archived) throw new Error('SKILL_BOT_NOT_FOUND');
      return selected;
    }
    if (isLocalComputerCommand(command)) {
      if (!local || !agentConfig || !state.localComputer)
        throw new Error('LOCAL_AGENT_UPDATE_REQUIRED');
      if (command.type === 'local.status') return local.status();
      if (command.type === 'local.permissions') return local.requestPermissions();
      if (command.type === 'local.preview') return local.preview(command.session, command.revision);
      if (command.type === 'local.connect') {
        await refresh();
        const profile = state.profiles.find((profile) => profile.id === command.bot);
        if (!profile || profile.archived) throw new Error('BOT_NOT_REGISTERED');
        if (state.agents[command.bot]?.running) throw new Error('LOCAL_TASK_BUSY');
        const model = profile.model || state.model.model;
        if (model !== command.model || (state.model.revision ?? 0) !== command.modelRevision)
          throw new Error('LOCAL_MODEL_CHANGED');
        if (!modelHasVision(model, modelCatalog(state.model.connections)))
          throw new Error('MODEL_COMPUTER_UNSUPPORTED');
        const result = await local.connect(command);
        publish({ ...state, localComputer: result });
        return result;
      }
      const result =
        command.type === 'local.pause'
          ? await local.pause(command.session, command.revision)
          : command.type === 'local.resume'
            ? await local.resume(command.session, command.revision)
            : await local.disconnect(command.session, command.revision);
      publish({ ...state, localComputer: result });
      return result;
    }
    if (command.type === 'clipboard.write') {
      clipboard.writeText(command.text);
      return { copied: true };
    }
    if (command.type === 'link.open') {
      // A human link click opens an ordinary browser; it never navigates this privileged renderer or grants agent fetch access.
      await shell.openExternal(new URL(command.url).href);
      return { opened: true };
    }
    if (
      command.type === 'setup.status' ||
      command.type === 'setup.start' ||
      command.type === 'setup.cancel'
    ) {
      if (nativeMode) return { required: false, phase: 'complete' };
      const owner = installation();
      const value =
        command.type === 'setup.start'
          ? await owner.start()
          : command.type === 'setup.cancel'
            ? await owner.cancel()
            : await owner.status();
      setupState = value;
      publish(state);
      return value;
    }
    if (command.type === 'connect') return connect();
    if (command.type === 'status') return state;
    if (
      command.type === 'recovery.status' ||
      command.type === 'recovery.review' ||
      command.type === 'recovery.restart' ||
      command.type === 'recovery.inspect' ||
      command.type === 'recovery.cancel' ||
      command.type === 'recovery.start'
    ) {
      if (agentConfig) {
        if (!client) throw new Error('RUNTIME_OFFLINE');
        if (command.type === 'recovery.status') {
          await refreshReboot();
          return reboot;
        }
        if (command.type === 'recovery.review') return client.invoke(command);
        recovering = true;
        rebootPublished = ++rebootRequested;
        published = ++requested;
        try {
          const result = await client.invoke(command);
          if (!isRebootStatus(result)) throw new Error('INVALID_RUNTIME_STATE');
          acceptReboot(result);
          publish(state);
          if (result.available && result.operation?.stage === 'complete') await refresh();
          return result;
        } finally {
          recovering = false;
          await refreshReboot();
        }
      }
      const owner = await managed();
      if (command.type === 'recovery.status') {
        await refreshReboot();
        return reboot;
      }
      if (command.type === 'recovery.review') return owner.recoveryReview();
      recovering = true;
      published = ++requested;
      try {
        const result =
          command.type === 'recovery.restart'
            ? await owner.recover(command.request)
            : command.type === 'recovery.inspect'
              ? await owner.inspectRecovery(command.id)
              : command.type === 'recovery.cancel'
                ? await owner.cancelRecovery(command.id)
                : command.type === 'recovery.start'
                  ? await owner.startRecovery(command.id)
                  : undefined;
        if (!result) throw new Error('INVALID_COMMAND');
        if (owner.connection) client = owner.connection;
        await refreshReboot();
        if (result.available && result.operation?.stage === 'complete' && client) await refresh();
        return result;
      } finally {
        recovering = false;
        await refreshReboot();
      }
    }
    if (command.type === 'runtime.inspect') {
      if (agentConfig) return inspectAgent();
      let owner: ManagedHost;
      try {
        owner = await managed();
      } catch (error) {
        if (closed) throw new Error('RUNTIME_CLOSED');
        const missing =
          !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
        return {
          scope: 'host',
          checkedAt: new Date().toISOString(),
          checks: [...diagnosticIds.host, ...diagnosticIds.runtime].map((id) => ({
            id,
            state:
              id === 'configuration' ? (missing ? 'unconfigured' : 'unavailable') : 'unchecked',
          })),
        } satisfies DiagnosticReport;
      }
      return owner.inspect();
    }
    if (!client || state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
    if (!recoveryReader(command)) {
      await refreshReboot();
      if (recoveryBlocked({ ...state, reboot })) throw new Error('RUNTIME_RECOVERY_PENDING');
    }
    const epoch = connection;
    const transcript = command.type === 'transcript.list' || command.type === 'transcript.content';
    const result = await client.invoke(command);
    // Reconnecting may reuse the same client object; an old read still belongs to the earlier connection.
    if (transcript && (closed || epoch !== connection)) throw new Error('RUNTIME_OFFLINE');
    if (!transcript && !['frame', 'files.list', 'files.read'].includes(command.type))
      await refresh();
    return result;
  }
  ipcMain.handle('daban:runtime', async (event, value): Promise<RuntimeReply> => {
    const frame = event.senderFrame;
    if (
      !trustedSender(
        {
          url: frame?.url || '',
          mainFrame: frame === event.sender.mainFrame,
          owned: BrowserWindow.getAllWindows().some((w) => w.webContents === event.sender),
        },
        rendererUrl,
      )
    )
      return { ok: false, error: 'UNTRUSTED_SENDER' };
    try {
      return { ok: true, value: await dispatch(parseCommand(value)) };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error && /^[A-Z_]+$/.test(error.message)
            ? error.message
            : 'RUNTIME_UNAVAILABLE',
      };
    }
  });
  const timer = setInterval(async () => {
    if (closed || polling) return;
    polling = true;
    try {
      await refreshReboot();
      if (!client || connecting || recovering) return;
      const interval = Object.values(state.agents).some(
        (task) => task.running && !['waiting', 'paused'].includes(task.phase),
      )
        ? 250
        : 1000;
      if (Date.now() - lastPoll < interval) return;
      lastPoll = Date.now();
      await refresh();
    } finally {
      polling = false;
    }
  }, 250);
  async function releaseInputs() {
    try {
      await client?.releaseInputs();
    } catch {
      console.error('Unable to release desktop input; ownership remains with the user.');
    }
  }
  return {
    connect,
    releaseInputs,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      ipcMain.removeHandler('daban:runtime');
      await setup?.close();
      // This cancels only the UI's startup wait; launchd keeps accepted tasks alive.
      await daemon?.close();
      host?.abort();
      await releaseInputs();
      agentTransport.abort();
      if (agentConfig) client = undefined;
      await loadingHost?.catch(() => {});
      await host?.close();
    },
  };
}
