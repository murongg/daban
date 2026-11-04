import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { request } from 'node:http';
import {
  isSoftwarePackages,
  isSoftwareReceipt,
  isSoftwareState,
  type SoftwarePlan,
  type SoftwareReceipt,
  type SoftwareState,
} from '@daban/protocol';
import { approvalHash } from './approval-rules.js';
import type { ToolResult } from './computer-tools.js';
import { errorCode, Fault } from './control.js';
import type { Interactions } from './interactions.js';

export const softwareSocket = '/run/daban-software/installer.sock';
export interface SoftwareBackend {
  plan(packages: string[]): Promise<SoftwareReceipt>;
  install(plan: SoftwarePlan): Promise<SoftwareReceipt>;
  receipt(id: string): Promise<SoftwareReceipt>;
  status(): Promise<SoftwareState>;
}
export class SoftwareClient implements SoftwareBackend {
  constructor(
    readonly socket = softwareSocket,
    private readonly owner = 0,
  ) {}
  private async call(route: string, body?: unknown) {
    const [socket, directory] = await Promise.all([
      lstat(this.socket),
      lstat(this.socket.slice(0, this.socket.lastIndexOf('/'))),
    ]);
    if (
      !socket.isSocket() ||
      socket.uid !== this.owner ||
      !directory.isDirectory() ||
      directory.uid !== this.owner ||
      directory.mode & 0o022
    )
      throw new Fault('SOFTWARE_UNSAFE_SOCKET');
    return new Promise<unknown>((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const connection = request(
        {
          socketPath: this.socket,
          path: route,
          method: data === undefined ? 'GET' : 'POST',
          headers: data
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
            : undefined,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) connection.destroy(new Fault('SOFTWARE_INVALID_RESPONSE'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (response.statusCode !== 200) {
                const code =
                  value &&
                  typeof value === 'object' &&
                  'error' in value &&
                  typeof value.error === 'string' &&
                  /^SOFTWARE_[A-Z_]+$/.test(value.error)
                    ? value.error
                    : 'SOFTWARE_UNAVAILABLE';
                reject(new Fault(code));
              } else resolve(value);
            } catch {
              reject(new Fault('SOFTWARE_INVALID_RESPONSE'));
            }
          });
        },
      );
      connection.setTimeout(180000, () => connection.destroy(new Fault('SOFTWARE_TIMEOUT')));
      connection.on('error', reject);
      connection.end(data);
    });
  }
  private async result(route: string, body?: unknown) {
    const value = await this.call(route, body);
    if (!isSoftwareReceipt(value)) throw new Fault('SOFTWARE_INVALID_RESPONSE');
    return value;
  }
  plan(packages: string[]) {
    return this.result('/plan', { packages });
  }
  install(plan: SoftwarePlan) {
    return this.result('/install', { id: plan.id, digest: plan.digest });
  }
  receipt(id: string) {
    return this.result(`/receipt?id=${encodeURIComponent(id)}`);
  }
  async status(): Promise<SoftwareState> {
    try {
      const value = await this.call('/status');
      if (!isSoftwareState(value)) throw new Fault('SOFTWARE_INVALID_RESPONSE');
      return value;
    } catch (error) {
      return { available: false, items: [], error: failure(error, 'SOFTWARE_UNAVAILABLE') };
    }
  }
}
interface SoftwareRun {
  id?: string;
  sessionId?: string;
  bot: string;
  conversationId?: string;
  abort: AbortController;
}
const result = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  ...(isError ? { isError: true } : {}),
});
function failure(error: unknown, fallback: string) {
  const code = errorCode(error);
  return code && /^(SOFTWARE|APPROVAL)_[A-Z_]+$/.test(code) ? code : fallback;
}
function delay(milliseconds: number, signal: AbortSignal) {
  return new Promise<undefined>((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(new Fault('SOFTWARE_CANCELLED'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve(undefined);
    }, milliseconds);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
  });
}
export class SoftwareTools {
  readonly surface = 'software';
  readonly fields: Record<string, string[]> = {
    software_list: [],
    software_install: ['packages', 'purpose'],
  };
  readonly list = [
    {
      name: 'software_list',
      description:
        'Read shared Linux software installation receipts and current status. Read-only; pending/unknown installation is not success. All Bots share installed applications.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'software_install',
      description:
        'Request official Debian software installation for the current human task. Requires a separate one-time Human confirmation of the exact package/version/dependency plan. No command, URL, repository, upgrade or removal is accepted. Installation is shared by all Bots. After cancellation/unknown outcome use software_list; never repeat the install.',
      inputSchema: {
        type: 'object',
        properties: {
          packages: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 8 },
          purpose: { type: 'string', maxLength: 500 },
        },
        required: ['packages', 'purpose'],
        additionalProperties: false,
      },
    },
  ];
  private readonly active = new Map<string, Promise<ToolResult>>();
  constructor(
    private readonly cards: Interactions,
    private readonly backend: SoftwareBackend,
    private readonly options: {
      pollMilliseconds?: number;
      assertLive?: (run: SoftwareRun) => unknown;
      policy?: import('./approval-rules.js').RulePolicy;
    } = {},
  ) {}
  status() {
    return this.backend.status();
  }
  invoke(run: SoftwareRun, name: string, args: Record<string, unknown> = {}) {
    if (name === 'software_list' && !Object.keys(args).length)
      return this.backend.status().then((value) => result(value, !value.available));
    if (
      name !== 'software_install' ||
      Object.keys(args).some((key) => !['packages', 'purpose'].includes(key)) ||
      !isSoftwarePackages(args.packages) ||
      typeof args.purpose !== 'string' ||
      !args.purpose.trim() ||
      args.purpose.length > 500 ||
      args.purpose.includes('\0') ||
      !run.id ||
      !run.sessionId
    )
      return Promise.resolve(result({ error: 'SOFTWARE_INVALID_REQUEST' }, true));
    const packages = [...args.packages].sort(),
      purpose = args.purpose;
    const id = createHash('sha256')
      .update(JSON.stringify([run.bot, run.id, run.sessionId, packages]))
      .digest('hex');
    const existing = this.active.get(id);
    if (existing) return existing;
    const pending = this.install(run, id, packages, purpose).finally(() => this.active.delete(id));
    this.active.set(id, pending);
    return pending;
  }
  private live(run: SoftwareRun) {
    if (run.abort.signal.aborted) throw new Fault('SOFTWARE_CANCELLED');
    this.options.assertLive?.(run);
  }
  private async inspect(plan: SoftwarePlan) {
    const receipt = await this.backend.receipt(plan.id);
    if (receipt.plan.id !== plan.id || receipt.plan.digest !== plan.digest)
      throw new Fault('SOFTWARE_INVALID_RESPONSE');
    return result({ receipt, shared: true }, receipt.phase !== 'installed');
  }
  private async install(
    run: SoftwareRun,
    id: string,
    packages: string[],
    purpose: string,
  ): Promise<ToolResult> {
    let dispatched = false;
    try {
      this.live(run);
      const previous = (await this.cards.list()).find((card) => card.id === id);
      if (previous) {
        if (
          previous.kind !== 'approval' ||
          previous.tool !== 'software_install' ||
          previous.bot !== run.bot ||
          previous.runId !== run.id ||
          previous.sessionId !== run.sessionId ||
          JSON.stringify(previous.plan.requested) !== JSON.stringify(packages)
        )
          throw new Fault('SOFTWARE_APPROVAL_CONFLICT');
        if (
          previous.status !== 'resolved' ||
          previous.reply?.kind !== 'decision' ||
          !previous.reply.allow
        )
          return result({ error: 'SOFTWARE_APPROVAL_REJECTED' }, true);
        // An existing decision is a receipt to inspect, never fresh authority to dispatch again.
        return await this.inspect(previous.plan);
      }
      const prepared = structuredClone(await this.backend.plan(packages));
      this.live(run);
      if (prepared.phase === 'installed') return result({ receipt: prepared, shared: true });
      if (
        prepared.phase !== 'planned' ||
        JSON.stringify(prepared.plan.requested) !== JSON.stringify(packages)
      )
        throw new Fault('SOFTWARE_INVALID_RESPONSE');
      const selector = {
        kind: 'software' as const,
        planId: prepared.plan.id,
        planHash: approvalHash(prepared.plan),
      };
      const policyDecision = await this.options.policy?.review(run, selector, 'ask');
      await this.cards.open(
        run.bot,
        run.id!,
        {
          id,
          sessionId: run.sessionId!,
          kind: 'approval',
          tool: 'software_install',
          plan: prepared.plan,
          purpose,
        },
        run.conversationId,
        policyDecision,
      );
      let approval = await this.cards.wait(run.bot, run.id!, id, run.abort.signal);
      while (approval.status === 'pending') {
        this.live(run);
        approval = await this.cards.wait(run.bot, run.id!, id, run.abort.signal);
      }
      this.live(run);
      if (
        approval.status !== 'resolved' ||
        approval.reply?.kind !== 'decision' ||
        !approval.reply.allow
      )
        throw new Fault('SOFTWARE_APPROVAL_REJECTED');
      if (policyDecision) {
        if (
          approval.kind !== 'approval' ||
          approval.tool !== 'software_install' ||
          approvalHash(approval.plan) !== selector.planHash ||
          approvalHash(prepared.plan) !== selector.planHash ||
          Date.parse(prepared.plan.expiresAt) <= Date.now()
        )
          throw new Fault('SOFTWARE_PLAN_CHANGED');
        // Persisted consent never authorizes a changed policy or package/dependency plan.
        this.options.policy!.assertCurrent(run, policyDecision);
        const current = await this.backend.receipt(prepared.plan.id);
        this.live(run);
        this.options.policy!.assertCurrent(run, policyDecision);
        if (
          approvalHash(current.plan) !== selector.planHash ||
          Date.parse(prepared.plan.expiresAt) <= Date.now()
        )
          throw new Fault('SOFTWARE_PLAN_CHANGED');
        if (current.phase !== 'planned')
          return result({ receipt: current, shared: true }, current.phase !== 'installed');
      }
      // The privileged broker owns installation after dispatch; task stop must not kill dpkg halfway through.
      dispatched = true;
      let receipt = await this.backend.install(prepared.plan);
      while (receipt.phase === 'installing') {
        await delay(this.options.pollMilliseconds ?? 500, run.abort.signal);
        this.live(run);
        receipt = await this.backend.receipt(prepared.plan.id);
      }
      if (receipt.plan.id !== prepared.plan.id || receipt.plan.digest !== prepared.plan.digest)
        throw new Fault('SOFTWARE_INVALID_RESPONSE');
      return result({ receipt, shared: true }, receipt.phase !== 'installed');
    } catch (error) {
      return result(
        {
          error: failure(
            error,
            run.abort.signal.aborted
              ? 'SOFTWARE_CANCELLED'
              : dispatched
                ? 'SOFTWARE_OUTCOME_UNKNOWN'
                : 'SOFTWARE_UNAVAILABLE',
          ),
          ...(dispatched ? { installationMayContinue: true } : {}),
        },
        true,
      );
    }
  }
}
