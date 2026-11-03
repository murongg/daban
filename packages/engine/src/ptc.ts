import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeRequire } from './dsh.js';
import { goalCommand } from './goals.js';
import { type ProgramBinding, type ProgramSpec, runProgram } from './program.js';

export const name = 'daban-ptc';
export const inject = ['agents', 'tools'];
export function ptcCommand(prompt: string) {
  return /^\/ptc(?:\s|$)/.test(prompt.trimStart());
}
interface Request {
  program: string;
  bindings: ProgramBinding[];
  cwd?: string;
  timeoutMs?: number | null;
  signal?: AbortSignal;
  sandboxPolicy?: unknown;
  stateOwner?: object;
}
interface Resolved extends ProgramSpec {
  cwd: string;
}
interface Agent {
  ctx: { tools: { presentAs(mode: 'native' | 'ptc'): unknown } };
}
interface Context {
  agents: { roots(): Agent[] };
  on(event: 'agent/created', callback: (payload: { agent: Agent }) => unknown): unknown;
  effect(factory: () => () => Promise<unknown>): unknown;
}
export function programmatic(prompt: string, planning: boolean, retry = false) {
  return ptcCommand(prompt) && !planning && !(retry && goalCommand(prompt));
}
export async function apply(ctx: Context, config: { sdkFile: string; active: boolean }) {
  const native = await import(
    pathToFileURL(runtimeRequire(config.sdkFile).resolve('@deepseek-ai/dsh-ptc-runtime')).href
  );
  class PureRuntime extends native.PtcRuntime {
    readonly language = 'typescript';
    readonly isolation = 'quickjs-wasm';
    private readonly specs = new WeakSet<Resolved>();
    private readonly runs = new Set<{ abort: AbortController; done: Promise<unknown> }>();
    get timeout() {
      return { defaultMs: 120000, maxMs: 300000 };
    }
    get executionInstructions() {
      return 'Execute erasable TypeScript as an async function body. Use await with tools and return a JSON value, or console.log small results. Each call has a fresh 32 MiB interpreter; no state, Node.js, process, require, imports, filesystem, timers or network APIs are available. All effects must use the generated tools, whose normal approval, ownership and cancellation rules still apply. Missing tool arguments become {}. Programs are never replayed automatically; inspect prior effects before retrying.';
    }
    constructor() {
      super(ctx);
      ctx.effect(() => async () => {
        for (const run of this.runs) run.abort.abort();
        await Promise.allSettled([...this.runs].map((run) => run.done));
      });
    }
    resolve(request: Request): Resolved {
      if (
        !request ||
        typeof request.program !== 'string' ||
        Buffer.byteLength(request.program) > 65536 ||
        request.program.includes('\0') ||
        !Array.isArray(request.bindings)
      )
        throw new Error('Invalid PTC program or bindings');
      if (request.sandboxPolicy !== undefined)
        throw new Error('File-policy escalation is unavailable in the pure interpreter');
      const cwd = request.cwd ?? process.cwd();
      const timeoutMs = request.timeoutMs ?? this.timeout.defaultMs;
      if (
        !isAbsolute(cwd) ||
        cwd.includes('\0') ||
        request.timeoutMs === null ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > this.timeout.maxMs
      )
        throw new Error('Invalid PTC directory or deadline');
      const names = new Set<string>();
      for (const binding of request.bindings) {
        if (
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(binding.global) ||
          native.PORTABLE_RESERVED_WORDS.has(binding.global) ||
          native.RESERVED_BINDING_GLOBALS.has(binding.global) ||
          binding.global.startsWith('__daban') ||
          names.has(binding.global)
        )
          throw new Error('Invalid PTC binding namespace');
        names.add(binding.global);
        if (
          !binding.functions ||
          typeof binding.functions !== 'object' ||
          Object.values(binding.functions).some((value) => typeof value !== 'function')
        )
          throw new Error('Invalid PTC binding function');
        if (binding.errorClass) {
          const error = binding.errorClass;
          if (
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(error.name) ||
            native.PORTABLE_RESERVED_WORDS.has(error.name) ||
            native.RESERVED_BINDING_GLOBALS.has(error.name) ||
            error.name.startsWith('__daban') ||
            names.has(error.name) ||
            !error.memberNameProperty ||
            native.RESERVED_ERROR_MEMBERS.has(error.memberNameProperty) ||
            /^__.+__$/.test(error.memberNameProperty)
          )
            throw new Error('Invalid PTC rejection contract');
          names.add(error.name);
        }
      }
      const spec = { ...request, cwd, timeoutMs };
      this.specs.add(spec);
      return spec;
    }
    async run(spec: Resolved) {
      if (!this.specs.delete(spec)) throw new Error('PTC execution requires a fresh resolved spec');
      const abort = new AbortController();
      const signal = spec.signal ? AbortSignal.any([spec.signal, abort.signal]) : abort.signal;
      const done = runProgram({ ...spec, signal });
      const run = { abort, done };
      this.runs.add(run);
      try {
        return await done;
      } finally {
        this.runs.delete(run);
      }
    }
    async release(_owner: object) {}
  }
  new PureRuntime();
  ctx.on('agent/created', ({ agent }) => {
    // Worker contexts retain native tools; only the accepted root opts into programmatic orchestration.
    agent.ctx.tools.presentAs(ctx.agents.roots()[0] === agent && config.active ? 'ptc' : 'native');
  });
}
