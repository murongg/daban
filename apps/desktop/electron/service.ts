import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { readVmConnection } from '@daban/engine/host';
import { secureDirectory } from '@daban/engine/local-computer';
import {
  type BrowserBinding,
  type DiagnosticReport,
  diagnosticIds,
  disconnected,
  isGroupPage,
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
import { app, BrowserWindow, clipboard, ipcMain, shell } from 'electron';
import { agentUpgradeBlocked, legacyAgentError } from '../shared/agent';
import { vmErrorKey } from '../shared/vm';
import { AgentSetup } from './agent-setup';
import type { PreparedAgentFiles, RuntimePreparation } from './components';
import { Daemon, daemonScope } from './daemon';
import { EnvironmentClient } from './environment-client';
import { pickFolder } from './folder-picker';
import { loadHost, type ManagedHost } from './host';
import { reconcileAgent } from './host-selection';
import { parseCommand, trustedSender } from './ipc';
import type { LocalComputer } from './local-computer';
import { NativeDaemon } from './native-daemon';
import { restartWindows } from './restart';
import { RuntimeClient } from './runtime';
import { Setup } from './setup';
import { pickSkill } from './skill-picker';
import { controlSocket } from './socket';
import { readAgentToken, unixFetch } from './unix';
import { prepareAgentUpdate } from './upgrade';
import { VmSettings } from './vm-settings';

interface AgentLocations {
  dataRoot?: string;
  socketPath?: string;
  vmConfig?: string;
  nativeFirst?: boolean;
}
export type AgentConfig = AgentLocations &
  (
    | { entry: string; executable: string; runtime?: never }
    | { runtime: RuntimePreparation; entry?: never; executable?: never }
  );

export function runtimeService(
  userData: string,
  rendererUrl: string,
  resources = join(__dirname, '..', 'resources/environment'),
  onSnapshot?: (snapshot: RuntimeSnapshot, scope?: string) => Promise<unknown>,
  agent?: AgentConfig,
  local?: LocalComputer,
  platform: NodeJS.Platform = process.platform,
) {
  const dataRoot = agent?.dataRoot ?? join(userData, 'agent');
  const vmConfig = agent?.vmConfig ?? join(userData, 'runtime.json');
  const agentScope = agent ? daemonScope(dataRoot, vmConfig) : undefined;
  const component = agent?.runtime;
  let files: PreparedAgentFiles | undefined =
    agent && !component && agent.entry && agent.executable
      ? { entry: agent.entry, executable: agent.executable }
      : undefined;
  const agentConfig = agent
    ? {
        get entry() {
          if (!files) throw Error('COMPONENT_NOT_READY');
          return files.entry;
        },
        get executable() {
          if (!files) throw Error('COMPONENT_NOT_READY');
          return files.executable;
        },
        dataRoot,
        vmConfig,
        ...(platform === 'win32' ? { qemuBundle: join(resources, 'qemu') } : {}),
        socketPath: agent.socketPath ?? controlSocket(join(userData, 'agent.sock'), agentScope!),
      }
    : undefined;
  let daemon: Daemon | NativeDaemon | undefined;
  let nativeMode = !!agentConfig && platform === 'win32';
  const nativeFirst = !!(component || agent?.nativeFirst);
  const environment =
    agentConfig && ['darwin', 'win32'].includes(platform) && nativeFirst
      ? new EnvironmentClient({
          ...{ dataRoot, socketPath: agentConfig.socketPath },
          scope: agentScope!,
        })
      : undefined;
  function componentChanged(next: SetupStatus) {
    // Log only bounded preparation enums/codes, never paths, URLs or model credentials.
    if (setupState?.phase !== next.phase)
      console.info('[agent-components]', next.phase, next.error ?? '');
    setupState = next;
    publish(state);
  }
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
  let pendingHandoff = false;
  let legacyHost = false;
  let connecting: Promise<RuntimeSnapshot> | undefined;
  let polling = false;
  let setupPolling = false;
  let closed = false;
  let updating = false;
  let connection = 0;
  let requested = 0,
    published = 0,
    lastPoll = 0,
    lastSetupPoll = 0;
  const vmSettings = new VmSettings({
    file: vmConfig,
    platform,
    handoff: async () => {
      if (closed || updating || connecting || recovering || !agentConfig || !files)
        throw new Error('AGENT_UPDATE_BUSY');
      await reconcileAgent({ ...agentConfig, scope: agentScope! }, nativeMode, { restart: true });
      if (closed) throw new Error('RUNTIME_CLOSED');
      await local?.revoke();
      await daemon?.close();
      daemon = undefined;
      client = undefined;
      reboot = undefined;
      connection++;
      published = ++requested;
    },
    reconnect: connect,
  });
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
  async function assertLegacyIdle(owner: RuntimeClient, epoch: number) {
    if (closed || client !== owner || connection !== epoch || !legacyHost)
      throw Error('AGENT_LEGACY_RESTART_UNAVAILABLE');
    const current = await owner.status();
    if (current.protocolVersion >= 43) throw Error('AGENT_LEGACY_RESTART_UNAVAILABLE');
    const blocked = agentUpgradeBlocked(current);
    if (blocked) throw Error(blocked);
    for (const group of current.groups!.items) {
      let before: number | undefined;
      for (let page = 0; ; page++) {
        // Refuse if the complete legacy queue cannot be inspected within a bounded read.
        if (page >= 100) throw Error('AGENT_LEGACY_RESTART_UNAVAILABLE');
        const value = await owner.invoke({
          type: 'group.read',
          group: group.id,
          ...(before === undefined ? {} : { before }),
        });
        if (!isGroupPage(value) || value.group.id !== group.id)
          throw Error('AGENT_LEGACY_RESTART_UNAVAILABLE');
        if (
          value.deliveries.some((delivery) =>
            ['pending', 'claimed', 'running'].includes(delivery.state),
          )
        )
          throw Error('AGENT_UPDATE_BUSY');
        if (value.nextBefore === undefined) break;
        if (before !== undefined && value.nextBefore >= before)
          throw Error('AGENT_LEGACY_RESTART_UNAVAILABLE');
        before = value.nextBefore;
      }
    }
    if (closed || client !== owner || connection !== epoch)
      throw Error('AGENT_LEGACY_RESTART_UNAVAILABLE');
    const last = await owner.status();
    const changed = agentUpgradeBlocked(last);
    if (changed) throw Error(changed);
  }
  async function connectAgent(): Promise<{ client: RuntimeClient; snapshot?: RuntimeSnapshot }> {
    if (!agentConfig) throw new Error('AGENT_NOT_CONFIGURED');
    if (component && !files) files = await component.prepare(componentChanged);
    if (closed) throw Error('RUNTIME_CLOSED');
    const windowsVm =
      platform === 'win32' && !nativeFirst ? await readVmConnection(vmConfig) : undefined;
    const exists = (file: string) =>
      access(file).then(
        () => true,
        (error: unknown) => {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
            return false;
          throw error;
        },
      );
    // Pre-host Mac installations still need the existing data migration before native stores can open.
    const legacyData =
      nativeFirst &&
      platform === 'darwin' &&
      (await exists(vmConfig)) &&
      !(await exists(join(dataRoot, 'model/control-token')));
    // Installing Linux adds a capability; it must not change ordinary tasks into guest tasks.
    const desiredNative =
      (nativeFirst && !legacyData) || (platform === 'win32' && !windowsVm?.enabled);
    if (nativeFirst) {
      const changed = await reconcileAgent({ ...agentConfig, scope: agentScope! }, desiredNative);
      if (changed) {
        client = undefined;
        reboot = undefined;
        publish(disconnected('connecting'));
        await daemon?.close();
        daemon = undefined;
      }
    }
    if (desiredNative) {
      await secureDirectory(agentConfig.dataRoot);
      const native =
        daemon instanceof NativeDaemon && daemon.mode === 'native'
          ? daemon
          : new NativeDaemon(agentConfig);
      daemon = native;
      const connected = await native.ensure();
      if (closed) throw Error('RUNTIME_CLOSED');
      nativeMode = true;
      if (!environment) setupState = { required: false, phase: 'complete' };
      else if (setupState?.target !== 'linux') setupState = undefined;
      return connected;
    }
    if (platform === 'win32') {
      await secureDirectory(agentConfig.dataRoot);
      nativeMode = false;
      const windows =
        daemon instanceof NativeDaemon && daemon.mode === 'vm'
          ? daemon
          : new NativeDaemon(agentConfig, 'vm');
      daemon = windows;
      const connected = await windows.ensure();
      if (closed) throw new Error('RUNTIME_CLOSED');
      setupState = { required: false, target: 'linux', phase: 'complete' };
      return connected;
    }
    // A partial configuration does not clear a user pause or authorize a legacy VM installation.
    const progress = nativeFirst ? { required: false } : await installation().status();
    if (progress.required) {
      if ('phase' in progress) setupState = progress;
      throw new Error('SETUP_REQUIRED');
    }
    await access(agentConfig.vmConfig);
    if (closed) throw new Error('RUNTIME_CLOSED');
    daemon ??= new Daemon(agentConfig, {
      onProgress: (next) => {
        if (closed) return;
        setupState = {
          ...next,
          required: true,
          target: 'linux',
          phase: next.phase === 'complete' ? 'connecting' : next.phase,
        };
        publish(state);
      },
    });
    await daemon.ensure();
    if (closed) throw new Error('RUNTIME_CLOSED');
    nativeMode = false;
    if (nativeFirst || setupState?.target === 'linux')
      setupState = { required: false, target: 'linux', phase: 'complete' };
    return { client: privateClient() };
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
      const response = await unixFetch(agentConfig.socketPath, {
        maxBytes: 64 * 1024,
        certificateFile: join(agentConfig.dataRoot, 'model/control-certificate.pem'),
      })('http://127.0.0.1:8766/agent/identity', {
        signal: AbortSignal.any([agentTransport.signal, AbortSignal.timeout(2000)]),
      });
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
    if (nativeMode && next.linux?.available === false) reboot = undefined;
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
    if (nativeMode && !state.reboot) return;
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
    if (updating) throw new Error('AGENT_UPDATING');
    if (connecting) return connecting;
    connecting = (async () => {
      connection++;
      const powerTicket = ++rebootRequested,
        ticket = ++requested;
      rebootPublished = powerTicket;
      published = ticket;
      const previous = state,
        previousClient = client;
      if (!(previousClient && nativeMode && nativeFirst)) publish(disconnected('connecting'));
      try {
        let snapshot: RuntimeSnapshot | undefined;
        if (agentConfig) ({ client, snapshot } = await connectAgent());
        else {
          const owner = await managed();
          await refreshReboot();
          client = await owner.connect();
        }
        // The startup read already authenticated and validated this snapshot. A newer mutation still wins.
        if (snapshot && ticket === published && powerTicket === rebootPublished) {
          if (snapshot.reboot) acceptReboot(snapshot.reboot, powerTicket);
          publish(snapshot);
        } else await refresh();
        pendingHandoff = nativeFirst && !nativeMode;
        legacyHost = false;
      } catch (error) {
        if (
          nativeFirst &&
          error instanceof Error &&
          error.message === 'AGENT_LEGACY_RESTART_REQUIRED'
        ) {
          const compatible = previousClient ?? privateClient();
          const active = await compatible.status();
          if (active.phase !== 'ready' || active.protocolVersion >= 43)
            throw Error('AGENT_UPDATE_UNAVAILABLE');
          client = compatible;
          nativeMode = active.agent?.execution === 'local-workspace';
          // Keep existing work usable; unsupported handoff is never permission for an automatic stop.
          legacyHost = true;
          pendingHandoff = false;
          setupState = {
            required: false,
            target: 'agent',
            phase: 'waiting',
            error: 'AGENT_LEGACY_RESTART_REQUIRED',
          };
          publish(active);
          return state;
        }
        if (nativeFirst && error instanceof Error && error.message === 'AGENT_UPDATE_BUSY') {
          client = previousClient ?? privateClient();
          const active = previousClient ? previous : await client.status();
          nativeMode = active.agent?.execution === 'local-workspace';
          pendingHandoff = true;
          setupState = { required: false, target: 'agent', phase: 'waiting' };
          publish(active);
          return state;
        }
        if (agentConfig) client = undefined;
        if (component && !files) {
          setupState = component.status();
          publish(disconnected('offline'));
          return state;
        }
        if (nativeMode) {
          publish(disconnected('offline', 'errors.runtimeConnectionUnavailable'));
          return state;
        }
        if (platform === 'win32') {
          publish(disconnected('offline', vmErrorKey(error) ?? 'vm.unavailable'));
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
    if (updating) {
      if (command.type === 'status') return state;
      throw new Error('AGENT_UPDATING');
    }
    if (command.type === 'agent.upgrade') {
      if (!legacyHost || !agentConfig || !client || platform !== 'darwin')
        throw Error('AGENT_LEGACY_RESTART_UNAVAILABLE');
      const owner = client,
        epoch = connection;
      updating = true;
      setupState = {
        required: false,
        target: 'agent',
        phase: 'connecting',
        error: legacyAgentError,
      };
      publish(state);
      try {
        await assertLegacyIdle(owner, epoch);
        try {
          await reconcileAgent({ ...agentConfig, scope: agentScope! }, nativeMode);
        } catch (error) {
          if (!(error instanceof Error) || error.message !== legacyAgentError) throw error;
          const manager = daemon instanceof Daemon ? daemon : new Daemon(agentConfig);
          daemon = manager;
          await manager.restartLegacy(() => assertLegacyIdle(owner, epoch));
        }
        client = undefined;
        legacyHost = false;
        pendingHandoff = false;
      } catch (error) {
        updating = false;
        setupState = {
          required: false,
          target: 'agent',
          phase: 'waiting',
          error: legacyAgentError,
        };
        await connect();
        throw error;
      } finally {
        updating = false;
      }
      const connected = await connect();
      if (connected.phase !== 'ready' || legacyHost) throw Error('AGENT_UPDATE_UNAVAILABLE');
      return connected;
    }
    if (command.type === 'vm.status') return vmSettings.status();
    if (command.type === 'vm.native') return vmSettings.native();
    if (command.type === 'setup.restart') {
      if (!environment || !nativeMode || !agentConfig || state.protocolVersion < 44)
        throw Error('QEMU_RESTART_UNAVAILABLE');
      updating = true;
      try {
        await restartWindows({
          status: () => environment.invoke('status'),
          idle: async () => {
            await prepareAgentUpdate({ ...agentConfig, scope: agentScope! });
            await local?.revoke();
            client = undefined;
          },
        });
      } catch (error) {
        updating = false;
        await connect();
        throw error;
      }
      app.quit();
      return { restarting: true };
    }
    if (command.type === 'folders.pick') {
      if (closed || !client || state.phase !== 'ready') throw new Error('RUNTIME_OFFLINE');
      if (!state.localFolders) throw new Error('RUNTIME_TOO_OLD');
      const owner = client,
        epoch = connection;
      const selected = await pickFolder(agentTransport.signal, command.suggestedPath);
      if (closed || client !== owner || connection !== epoch) throw new Error('RUNTIME_OFFLINE');
      if (selected === null) return null;
      return owner.connectFolder(command.bot, selected);
    }
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
      if (command.type === 'local.windows') return local.windows();
      if (command.type === 'local.status' || command.type === 'local.permissions') {
        const result =
          command.type === 'local.status' ? local.status() : await local.requestPermissions();
        publish({ ...state, localComputer: result });
        return result;
      }
      if (command.type === 'local.preview') return local.preview(command.session, command.revision);
      if (command.type === 'local.connect') {
        await refresh();
        if (state.hostBrowser?.connections.some((item) => item.bot === command.bot))
          throw new Error('HOST_BROWSER_CONNECTED');
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
      command.type === 'setup.enable' ||
      command.type === 'setup.cancel'
    ) {
      if (component && !files) {
        if (command.type === 'setup.cancel') return component.cancel();
        if (command.type === 'setup.start') {
          files = await component.resume(componentChanged);
          await connect();
        }
        setupState = files ? setupState : component.status();
        publish(state);
        return setupState;
      }
      if (environment && nativeMode) {
        if (command.type === 'setup.enable' && state.protocolVersion < 44)
          throw Error('RUNTIME_TOO_OLD');
        const value = await environment.invoke(
          command.type === 'setup.start'
            ? 'start'
            : command.type === 'setup.enable'
              ? 'enable'
              : command.type === 'setup.cancel'
                ? 'cancel'
                : 'status',
          command.type === 'setup.start' && command.mode
            ? { mode: command.mode }
            : command.type === 'setup.enable'
              ? { confirmed: true }
              : {},
        );
        setupState = value;
        publish(state);
        return value;
      }
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
      if (nativeMode && !state.reboot) throw new Error('RECOVERY_UNAVAILABLE');
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
    if (closed || updating || polling) return;
    polling = true;
    try {
      await refreshReboot();
      if (
        pendingHandoff &&
        client &&
        !connecting &&
        Date.now() - lastSetupPoll > 1000 &&
        !Object.values(state.agents).some((task) => task.running)
      ) {
        lastSetupPoll = Date.now();
        await connect();
      }
      if (
        !legacyHost &&
        environment &&
        nativeMode &&
        client &&
        !connecting &&
        !setupPolling &&
        Date.now() - lastSetupPoll > 1000
      ) {
        const epoch = connection,
          owner = client,
          previous = setupState;
        lastSetupPoll = Date.now();
        setupPolling = true;
        // Optional setup must not hold up chat status, and a late poll must not replace a setup command's result.
        environment
          .invoke('status')
          .then((next) => {
            if (
              !closed &&
              !updating &&
              connection === epoch &&
              client === owner &&
              setupState === previous
            ) {
              setupState = next;
              publish(state);
            }
          })
          .catch(() => {})
          .finally(() => {
            setupPolling = false;
          });
      }
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
    async browserTarget(bot: string, epoch: number, binding: BrowserBinding) {
      if (!client || state.phase !== 'ready' || closed || updating || recoveryBlocked(state))
        throw new Error('RUNTIME_OFFLINE');
      return (await client.invoke({
        type: 'hostBrowser',
        request: { action: 'target', bot, epoch, binding },
      })) as { target: string };
    },
    releaseInputs,
    async prepareUpdate() {
      if (closed || !agentConfig) throw new Error('AGENT_UPDATE_UNAVAILABLE');
      if (
        updating ||
        connecting ||
        recovering ||
        (setupState &&
          [
            'downloading',
            'verifying',
            'extracting',
            'creating',
            'starting',
            'connecting',
            'cancelling',
          ].includes(setupState.phase))
      )
        throw new Error('AGENT_UPDATE_BUSY');
      updating = true;
      try {
        if (!nativeMode && platform !== 'win32') {
          const manager = daemon instanceof Daemon ? daemon : new Daemon(agentConfig);
          daemon = manager;
          if (await manager.inactive()) {
            client = undefined;
            return;
          }
        }
        await prepareAgentUpdate({ ...agentConfig, scope: agentScope! });
        client = undefined;
      } catch (error) {
        updating = false;
        throw error;
      }
    },
    async resumeAfterUpdate() {
      updating = false;
      if (!closed) await connect();
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      ipcMain.removeHandler('daban:runtime');
      await component?.close();
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
