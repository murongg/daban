import { createHash } from 'node:crypto';
import {
  isPreflightOptionsQuery,
  isPreflightQuery,
  isPreflightRead,
  isPreflightReport,
  type LocalComputerStatus,
  type PreflightCheck,
  type PreflightOptions,
  type PreflightOptionsQuery,
  type PreflightPackage,
  type PreflightQuery,
  type PreflightRead,
  type PreflightReport,
  type PreflightRequirement,
  type PreflightStamp,
  preflightByteLimit,
  preflightJson,
  preflightQueryKey,
  preflightReportData,
  preflightSources,
} from '@daban/protocol';
import { Fault } from './control.js';
import { preflightPackage } from './preflight-export.js';

export interface PreflightProfile {
  revision: number;
  model?: string;
}
export interface PreflightModel {
  revision: number;
  configured: boolean;
  defaultModel: string;
  searchConfigured: boolean;
  models: {
    id: string;
    vision: boolean;
    toolCall?: boolean;
    contextWindow: number;
    maxTokens: number;
  }[];
}
export interface PreflightMcp {
  revision: number;
  connections: {
    id: string;
    revision: number;
    bindingRevision: number;
    enabled: boolean;
    available: boolean;
    label: string;
    digest?: string;
    bindingDigest?: string;
    tools: { alias: string; label: string; selected: boolean }[];
  }[];
}
export interface PreflightRuntime {
  supported: boolean;
  connected: boolean;
  identity: string | null;
  documents: boolean;
  computer?: {
    available?: boolean;
    connected: boolean;
    revision: number;
    instance?: string;
    owner?: 'agent' | 'human' | 'handoff';
    epoch?: number;
  };
}
export interface PreflightSources {
  scope(): string;
  authorize(bot: string): Promise<PreflightProfile>;
  model(): Promise<PreflightModel>;
  mcp(bot: string): Promise<PreflightMcp>;
  runtime(bot: string): Promise<PreflightRuntime>;
  local(): Promise<LocalComputerStatus>;
}
export interface PreflightLimits {
  now?: () => number;
  sourceTimeout?: number;
  totalTimeout?: number;
  reportLimit?: number;
  totalBytes?: number;
  productVersion?: string;
}

type Sample<T> =
  | { state: 'value'; value: T; at: string }
  | { state: 'error'; fault?: Fault }
  | { state: 'timeout' };
interface Samples {
  model?: Sample<PreflightModel>;
  mcp?: Sample<PreflightMcp>;
  runtime?: Sample<PreflightRuntime>;
  local?: Sample<LocalComputerStatus>;
}
interface Entry {
  query: PreflightQuery;
  key: string;
  scope: string;
  expires: number;
  bytes: number;
  pending?: Promise<PreflightReport>;
  report?: PreflightReport;
  package?: PreflightPackage;
}
const hash = (value: unknown) => createHash('sha256').update(preflightJson(value)).digest('hex');
const value = <T>(sample?: Sample<T>) => (sample?.state === 'value' ? sample.value : undefined);
const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class Preflight {
  private readonly entries = new Map<string, Entry>();
  private readonly pending = new Map<string, Promise<Sample<unknown>>>();
  private readonly now: () => number;
  private bytes = 0;
  private closed = false;
  constructor(
    readonly sources: PreflightSources,
    readonly limits: PreflightLimits = {},
  ) {
    this.now = limits.now ?? Date.now;
  }
  private deadline() {
    return performance.now() + (this.limits.totalTimeout ?? 3000);
  }
  private assertOpen() {
    if (this.closed) throw new Fault('PREFLIGHT_REPORT_EXPIRED', 410);
  }
  private async read<T>(key: string, load: () => Promise<T>, deadline: number): Promise<Sample<T>> {
    this.assertOpen();
    let shared = this.pending.get(key);
    if (!shared) {
      // Hung probes survive response deadlines; cap their dynamic Bot keys as well as retained reports.
      if (this.pending.size >= 256)
        return { state: 'error', fault: new Fault('PREFLIGHT_LIMIT', 409) };
      shared = Promise.resolve()
        .then(load)
        .then<Sample<unknown>>((result) => ({
          state: 'value',
          value: structuredClone(result),
          at: new Date(this.now()).toISOString(),
        }))
        .catch<Sample<unknown>>((error) => ({
          state: 'error',
          ...(error instanceof Fault ? { fault: error } : {}),
        }))
        .finally(() => {
          if (this.pending.get(key) === shared) this.pending.delete(key);
        });
      this.pending.set(key, shared);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // A response deadline must not retire a live source and start another probe on the next request.
      return await Promise.race([
        shared as Promise<Sample<T>>,
        new Promise<Sample<T>>((resolve) => {
          timer = setTimeout(
            () => resolve({ state: 'timeout' }),
            Math.max(0, Math.min(this.limits.sourceTimeout ?? 2000, deadline - performance.now())),
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  private async authorize(bot: string, deadline: number) {
    const result = await this.read(`profile:${bot}`, () => this.sources.authorize(bot), deadline);
    if (result.state !== 'value')
      throw result.state === 'error' && result.fault
        ? result.fault
        : new Fault('PREFLIGHT_OWNER_UNAVAILABLE', 503);
    return result.value;
  }
  private async sample(
    query: PreflightQuery,
    deadline: number,
    previous?: Samples,
  ): Promise<Samples> {
    const samples: Samples = {};
    const needed = (kind: PreflightRequirement['kind']) =>
      query.requirements.some((row) => row.kind === kind);
    const local = query.requirements.some((row) => row.kind === 'computer' && row.mode === 'local');
    const linux = query.requirements.some((row) => row.kind === 'computer' && row.mode === 'linux');
    const tasks: Promise<unknown>[] = [];
    if (needed('model') || needed('search') || local)
      tasks.push(
        (async () => {
          samples.model =
            previous?.model && previous.model.state !== 'value'
              ? previous.model
              : await this.read('model', () => this.sources.model(), deadline);
        })(),
      );
    if (needed('mcp'))
      tasks.push(
        (async () => {
          samples.mcp =
            previous?.mcp && previous.mcp.state !== 'value'
              ? previous.mcp
              : await this.read(`mcp:${query.bot}`, () => this.sources.mcp(query.bot), deadline);
        })(),
      );
    if (needed('office') || linux)
      tasks.push(
        (async () => {
          samples.runtime =
            previous?.runtime && previous.runtime.state !== 'value'
              ? previous.runtime
              : await this.read(
                  `runtime:${query.bot}`,
                  () => this.sources.runtime(query.bot),
                  deadline,
                );
        })(),
      );
    if (local)
      tasks.push(
        (async () => {
          samples.local =
            previous?.local && previous.local.state !== 'value'
              ? previous.local
              : await this.read('local', () => this.sources.local(), deadline);
        })(),
      );
    await Promise.all(tasks);
    return samples;
  }
  private stamps(profile: PreflightProfile, samples: Samples): PreflightStamp[] {
    const model = value(samples.model),
      mcp = value(samples.mcp),
      runtime = value(samples.runtime),
      local = value(samples.local);
    const values: Record<PreflightStamp['source'], unknown> = {
      profile: [profile.revision, profile.model ?? null],
      model: model ? [model.revision, model.configured] : null,
      search: model ? [model.revision, model.searchConfigured] : null,
      mcp: mcp
        ? [
            mcp.revision,
            mcp.connections.map((row) => [
              row.id,
              row.revision,
              row.bindingRevision,
              row.enabled,
              row.available,
              row.digest ?? null,
              row.bindingDigest ?? null,
              row.tools.filter((tool) => tool.selected).map((tool) => tool.alias),
            ]),
          ]
        : null,
      runtime: runtime
        ? [runtime.identity, runtime.supported, runtime.connected, runtime.documents]
        : null,
      computer: local
        ? [
            local.platform,
            local.available,
            local.permissions.screen,
            local.permissions.accessibility,
            local.session
              ? [
                  local.session.id,
                  local.session.bot,
                  local.session.revision,
                  local.session.owner,
                  local.session.model,
                  local.session.modelRevision,
                ]
              : null,
          ]
        : runtime
          ? [
              runtime.identity,
              runtime.connected,
              runtime.computer
                ? [
                    runtime.computer.available ?? true,
                    runtime.computer.connected,
                    runtime.computer.revision,
                    runtime.computer.instance ?? null,
                    runtime.computer.owner ?? null,
                    runtime.computer.epoch ?? null,
                  ]
                : null,
            ]
          : null,
    };
    return preflightSources.map((source) => ({
      source,
      stamp: values[source] === null ? null : hash(values[source]),
    }));
  }
  private check(
    requirement: PreflightRequirement,
    index: number,
    bot: string,
    profile: PreflightProfile,
    samples: Samples,
  ): PreflightCheck {
    const sampled =
      requirement.kind === 'mcp'
        ? samples.mcp
        : requirement.kind === 'model' || requirement.kind === 'search'
          ? samples.model
          : requirement.kind === 'computer' && requirement.mode === 'local'
            ? samples.local
            : samples.runtime;
    const base = {
      index,
      observedAt: sampled?.state === 'value' ? sampled.at : new Date(this.now()).toISOString(),
    };
    const result = (
      state: PreflightCheck['state'],
      reason: PreflightCheck['reason'],
      action: PreflightCheck['action'],
      evidence: PreflightCheck['evidence'],
    ): PreflightCheck => ({ ...base, state, reason, action, evidence });
    const unavailable = (sample?: Sample<unknown>) =>
      sample?.state === 'error' && sample.fault?.code === 'PREFLIGHT_SOURCE_CHANGED'
        ? result('stale', 'CONFIG_CHANGED', 'recheck', 'unavailable')
        : result(
            'unknown',
            sample?.state === 'timeout' ? 'CHECK_TIMED_OUT' : 'OWNER_UNAVAILABLE',
            'recheck',
            'unavailable',
          );
    const model = value(samples.model);
    const selected = model?.models.find((row) => row.id === (profile.model ?? model.defaultModel));
    if (requirement.kind === 'model') {
      if (!model) return unavailable(samples.model);
      base.observedAt = samples.model!.state === 'value' ? samples.model!.at : base.observedAt;
      if (!model.configured || !selected)
        return result('missing', 'MODEL_NOT_CONFIGURED', 'models', 'local-config');
      if (
        (requirement.vision && !selected.vision) ||
        (requirement.tools && selected.toolCall === false)
      )
        return result('missing', 'MODEL_CAPABILITY_MISSING', 'models', 'local-config');
      if (
        requirement.minContextTokens !== undefined &&
        selected.contextWindow - selected.maxTokens < requirement.minContextTokens
      )
        return result('missing', 'INPUT_BUDGET_TOO_SMALL', 'models', 'local-config');
      if (requirement.tools && selected.toolCall === undefined)
        return result('unknown', 'MODEL_CAPABILITY_UNKNOWN', 'models', 'local-config');
      // Saved metadata is a configuration fact; no inference or paid provider request was performed.
      return result('ready', 'CONFIG_PRESENT', 'none', 'local-config');
    }
    if (requirement.kind === 'search') {
      if (!model) return unavailable(samples.model);
      return result(
        model.searchConfigured ? 'ready' : 'missing',
        model.searchConfigured ? 'CONFIG_PRESENT' : 'SEARCH_NOT_CONFIGURED',
        model.searchConfigured ? 'none' : 'search',
        'local-config',
      );
    }
    if (requirement.kind === 'mcp') {
      const mcp = value(samples.mcp);
      if (!mcp) return unavailable(samples.mcp);
      const connection = mcp.connections.find((row) => row.id === requirement.connection);
      // Unknown and private connection IDs have the same refusal, before disclosing catalog or binding facts.
      if (!connection) throw new Fault('PREFLIGHT_NOT_AUTHORIZED', 403);
      if (!connection.enabled)
        return result('missing', 'MCP_NOT_SELECTED', 'integrations', 'cached-catalog');
      if (
        !connection.available ||
        connection.digest !== requirement.catalogDigest ||
        connection.bindingDigest !== requirement.catalogDigest
      )
        return result('stale', 'MCP_CATALOG_STALE', 'integrations', 'cached-catalog');
      if (!connection.tools.some((tool) => tool.alias === requirement.tool && tool.selected))
        return result('missing', 'MCP_NOT_SELECTED', 'integrations', 'cached-catalog');
      return result('ready', 'CONFIG_PRESENT', 'none', 'cached-catalog');
    }
    if (requirement.kind === 'computer' && requirement.mode === 'local') {
      const local = value(samples.local);
      if (!local) return unavailable(samples.local);
      if (!local.available && local.error)
        return result('unknown', 'OWNER_UNAVAILABLE', 'computer', 'unavailable');
      if (local.platform === 'unsupported')
        return result('unsupported', 'CAPABILITY_UNSUPPORTED', 'computer', 'local-status');
      if (!local.available)
        return result('unknown', 'OWNER_UNAVAILABLE', 'computer', 'unavailable');
      if (
        !local.permissions.screen ||
        (requirement.access === 'control' && !local.permissions.accessibility)
      )
        return result('missing', 'LOCAL_PERMISSION_MISSING', 'computer', 'local-status');
      if (!model) return unavailable(samples.model);
      if (!local.session)
        return result('missing', 'COMPUTER_DISCONNECTED', 'computer', 'local-status');
      if (
        local.session.bot !== bot ||
        local.session.modelRevision !== model.revision ||
        local.session.model !== (profile.model ?? model.defaultModel)
      )
        return result('missing', 'LOCAL_SESSION_MISMATCH', 'computer', 'local-status');
      if (requirement.access === 'control' && local.session.owner !== 'agent')
        return result('missing', 'CONTROL_HELD_BY_HUMAN', 'computer', 'local-status');
      return result('ready', 'CONFIG_PRESENT', 'none', 'local-status');
    }
    const runtime = value(samples.runtime);
    if (!runtime) return unavailable(samples.runtime);
    if (!runtime.supported || (requirement.kind === 'office' && !runtime.documents))
      return result('unsupported', 'CAPABILITY_UNSUPPORTED', 'environment', 'local-status');
    if (requirement.kind === 'computer' && runtime.computer?.available === false)
      return result('unknown', 'OWNER_UNAVAILABLE', 'computer', 'unavailable');
    if (!runtime.connected || (requirement.kind === 'computer' && !runtime.computer?.connected))
      return result('missing', 'COMPUTER_DISCONNECTED', 'computer', 'local-status');
    if (
      requirement.kind === 'computer' &&
      requirement.access === 'control' &&
      runtime.computer?.owner !== 'agent'
    )
      return result('missing', 'CONTROL_HELD_BY_HUMAN', 'computer', 'local-status');
    return result('ready', 'CONFIG_PRESENT', 'none', 'local-status');
  }
  private affected(requirement: PreflightRequirement): PreflightStamp['source'][] {
    if (requirement.kind === 'model') return ['profile', 'model'];
    if (requirement.kind === 'search') return ['profile', 'search'];
    if (requirement.kind === 'mcp') return ['profile', 'mcp'];
    if (requirement.kind === 'office') return ['profile', 'runtime'];
    return requirement.mode === 'local'
      ? ['profile', 'model', 'computer']
      : ['profile', 'runtime', 'computer'];
  }
  private reserve(bytes: number) {
    if (this.bytes + bytes > (this.limits.totalBytes ?? 4 * 1024 * 1024))
      throw new Fault('PREFLIGHT_LIMIT', 409);
    this.bytes += bytes;
  }
  private prune() {
    for (const [id, entry] of this.entries)
      if (!entry.pending && entry.expires <= this.now()) {
        this.bytes -= entry.bytes;
        this.entries.delete(id);
      }
  }
  private async build(entry: Entry, profile: PreflightProfile, deadline: number) {
    const before = await this.sample(entry.query, deadline);
    const [after, current] = await Promise.all([
      this.sample(entry.query, deadline, before),
      this.authorize(entry.query.bot, deadline),
    ]);
    this.assertOpen();
    if (this.sources.scope() !== entry.scope) throw new Fault('PREFLIGHT_REPORT_EXPIRED', 410);
    const versions = this.stamps(profile, before),
      next = this.stamps(current, after);
    const checks = entry.query.requirements.map((requirement, index) => {
      const row = this.check(requirement, index, entry.query.bot, profile, before);
      const latest = this.check(requirement, index, entry.query.bot, current, after);
      // A failed reread cannot prove a revision change; retain its actual cause and evidence.
      if (['CHECK_TIMED_OUT', 'OWNER_UNAVAILABLE', 'CONFIG_CHANGED'].includes(latest.reason))
        return latest;
      const relevant = this.affected(requirement);
      if (
        relevant.some(
          (source) =>
            versions.find((stamp) => stamp.source === source)!.stamp !==
            next.find((stamp) => stamp.source === source)!.stamp,
        )
      )
        return {
          ...row,
          state: 'stale' as const,
          reason: 'CONFIG_CHANGED' as const,
          action: 'recheck' as const,
        };
      return row;
    });
    const checked = this.now();
    const checkedAt = new Date(checked).toISOString();
    const data: Omit<PreflightReport, 'digest'> = {
      schema: 1,
      id: entry.query.id,
      bot: entry.query.bot,
      workspace: entry.scope,
      checkedAt,
      freshUntil: new Date(checked + 30000).toISOString(),
      expiresAt: new Date(checked + 300000).toISOString(),
      requirements: entry.query.requirements,
      versions,
      checks,
      summary: checks.every((row) => row.state === 'ready') ? 'ready' : 'attention',
      externalProbe: 'not-run',
    };
    const report = { ...data, digest: hash(data) };
    if (!isPreflightReport(report)) throw new Fault('PREFLIGHT_INVALID_REPORT', 500);
    const bytes = Buffer.byteLength(preflightJson(report));
    if (bytes > preflightByteLimit) throw new Fault('PREFLIGHT_LIMIT');
    this.reserve(bytes);
    entry.bytes += bytes;
    entry.expires = Date.parse(report.expiresAt);
    entry.report = report;
    return report;
  }
  async inspect(input: PreflightQuery): Promise<PreflightReport> {
    if (!isPreflightQuery(input)) throw new Fault('INVALID_PREFLIGHT_QUERY', 400);
    const query = structuredClone(input),
      scope = this.sources.scope(),
      deadline = this.deadline();
    this.assertOpen();
    this.prune();
    const key = preflightQueryKey(query);
    let entry = this.entries.get(query.id);
    if (entry && (entry.key !== key || entry.scope !== scope))
      throw new Fault('PREFLIGHT_ID_REUSED', 409);
    const profile = await this.authorize(query.bot, deadline);
    entry = this.entries.get(query.id);
    if (entry && (entry.key !== key || entry.scope !== scope))
      throw new Fault('PREFLIGHT_ID_REUSED', 409);
    if (entry?.report) {
      await this.revalidate(entry, deadline);
      return structuredClone(entry.report);
    }
    if (!entry) {
      if (this.entries.size >= (this.limits.reportLimit ?? 50))
        throw new Fault('PREFLIGHT_LIMIT', 409);
      const bytes = Buffer.byteLength(preflightJson(query));
      this.reserve(bytes);
      entry = { query, key, scope, expires: this.now() + 300000, bytes };
      this.entries.set(query.id, entry);
      const captured = entry;
      entry.pending = this.build(entry, profile, deadline)
        .catch((error) => {
          if (this.entries.get(query.id) === captured) {
            this.entries.delete(query.id);
            this.bytes -= captured.bytes;
          }
          throw error;
        })
        .finally(() => {
          captured.pending = undefined;
        });
    }
    const report = await entry.pending!;
    await this.authorize(query.bot, deadline);
    if (scope !== this.sources.scope()) throw new Fault('PREFLIGHT_REPORT_EXPIRED', 410);
    return structuredClone(report);
  }
  private async revalidate(entry: Entry, deadline: number) {
    if (entry.expires <= this.now() || entry.scope !== this.sources.scope())
      throw new Fault('PREFLIGHT_REPORT_EXPIRED', 410);
    await this.authorize(entry.query.bot, deadline);
    const before = await this.sample(entry.query, deadline);
    const samples = await this.sample(entry.query, deadline, before);
    // A Bot can be archived while another owner is returning; authorize after all awaited facts too.
    const profile = await this.authorize(entry.query.bot, deadline);
    this.assertOpen();
    if (entry.scope !== this.sources.scope() || entry.expires <= this.now())
      throw new Fault('PREFLIGHT_REPORT_EXPIRED', 410);
    const current = this.stamps(profile, samples);
    if (
      Object.values(samples).some((sample) => sample.state !== 'value') ||
      current.some(
        (stamp) =>
          stamp.stamp !== entry.report!.versions.find((row) => row.source === stamp.source)!.stamp,
      )
    )
      throw new Fault('PREFLIGHT_AUTHORITY_CHANGED', 409);
  }
  async options(input: PreflightOptionsQuery): Promise<PreflightOptions> {
    if (!isPreflightOptionsQuery(input)) throw new Fault('INVALID_PREFLIGHT_QUERY', 400);
    const query = structuredClone(input),
      deadline = this.deadline(),
      scope = this.sources.scope();
    const profile = await this.authorize(query.bot, deadline);
    const sample = await this.read(`mcp:${query.bot}`, () => this.sources.mcp(query.bot), deadline);
    const mcp = value(sample);
    if (!mcp) {
      const page: PreflightOptions = {
        bot: query.bot,
        workspace: scope,
        state: 'unavailable',
        version: null,
        truncated: false,
        items: [],
      };
      const bytes = Buffer.byteLength(preflightJson(page));
      this.reserve(bytes);
      try {
        await this.authorize(query.bot, deadline);
        if (scope !== this.sources.scope()) throw new Fault('PREFLIGHT_OPTIONS_STALE', 409);
        return page;
      } finally {
        this.bytes -= bytes;
      }
    }
    const all = mcp.connections
      .filter(
        (row) => row.enabled && row.available && row.digest && row.digest === row.bindingDigest,
      )
      .flatMap((row) =>
        row.tools
          .filter((tool) => tool.selected)
          .map((tool) => ({
            connection: row.id,
            catalogDigest: row.digest!,
            tool: tool.alias,
            connectionLabel: row.label.slice(0, 80),
            toolLabel: tool.label.slice(0, 120),
          })),
      )
      .sort((a, b) => textOrder(a.connection, b.connection) || textOrder(a.tool, b.tool));
    const version = hash([
      scope,
      query.bot,
      this.stamps(profile, { mcp: sample }).find((row) => row.source === 'mcp')!.stamp,
      all,
    ]);
    let offset = 0;
    if (query.cursor) {
      let cursor: unknown;
      try {
        cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      } catch {
        throw new Fault('INVALID_PREFLIGHT_CURSOR', 400);
      }
      if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor))
        throw new Fault('INVALID_PREFLIGHT_CURSOR', 400);
      const row = cursor as Record<string, unknown>;
      if (
        Object.keys(row).sort().join(',') !== 'bot,offset,version,workspace' ||
        !Number.isInteger(row.offset) ||
        Number(row.offset) < 50 ||
        Number(row.offset) >= 500 ||
        Number(row.offset) % 50
      )
        throw new Fault('INVALID_PREFLIGHT_CURSOR', 400);
      if (row.bot !== query.bot || row.workspace !== scope || row.version !== version)
        throw new Fault('PREFLIGHT_OPTIONS_STALE', 409);
      offset = Number(row.offset);
      if (offset >= all.length) throw new Fault('INVALID_PREFLIGHT_CURSOR', 400);
    }
    const capped = all.slice(0, 500);
    const page: PreflightOptions = {
      bot: query.bot,
      workspace: scope,
      state: capped.length ? 'ready' : 'empty',
      version,
      truncated: all.length > 500,
      items: capped.slice(offset, offset + 50),
      ...(offset + 50 < capped.length
        ? {
            next: Buffer.from(
              preflightJson({ bot: query.bot, workspace: scope, version, offset: offset + 50 }),
            ).toString('base64url'),
          }
        : {}),
    };
    const bytes = Buffer.byteLength(preflightJson(page));
    if (bytes > preflightByteLimit) throw new Fault('PREFLIGHT_LIMIT');
    this.reserve(bytes);
    try {
      const after = await this.read(
        `mcp:${query.bot}`,
        () => this.sources.mcp(query.bot),
        deadline,
      );
      // Source I/O can outlast the Bot's authority; authorize after it before publishing labels.
      const current = await this.authorize(query.bot, deadline);
      if (
        this.sources.scope() !== scope ||
        current.revision !== profile.revision ||
        this.stamps(current, { mcp: after }).find((row) => row.source === 'mcp')!.stamp !==
          this.stamps(profile, { mcp: sample }).find((row) => row.source === 'mcp')!.stamp
      )
        throw new Fault('PREFLIGHT_OPTIONS_STALE', 409);
      return page;
    } finally {
      this.bytes -= bytes;
    }
  }
  async preview(input: PreflightRead, exporting = false): Promise<PreflightPackage> {
    if (!isPreflightRead(input)) throw new Fault('INVALID_PREFLIGHT_QUERY', 400);
    const query = structuredClone(input),
      deadline = this.deadline();
    this.assertOpen();
    this.prune();
    const entry = this.entries.get(query.id);
    if (!entry?.report) throw new Fault('PREFLIGHT_REPORT_EXPIRED', 410);
    if (
      entry.report.digest !== query.digest ||
      hash(preflightReportData(entry.report)) !== query.digest
    )
      throw new Fault('PREFLIGHT_DIGEST_MISMATCH', 400);
    // Reports are observations, never permission tickets: every read reaches the original live owners again.
    await this.revalidate(entry, deadline);
    if (exporting && !entry.package) throw new Fault('PREFLIGHT_PREVIEW_REQUIRED', 409);
    if (!entry.package) {
      const projected = preflightPackage(
        entry.report,
        this.now(),
        this.limits.productVersion ?? '0.0.0',
      );
      const bytes = Buffer.byteLength(preflightJson(projected));
      if (bytes > preflightByteLimit) throw new Fault('PREFLIGHT_LIMIT');
      this.reserve(bytes);
      entry.bytes += bytes;
      entry.package = projected;
    }
    return structuredClone(entry.package);
  }
  close() {
    this.closed = true;
    this.entries.clear();
    this.bytes = 0;
  }
}
