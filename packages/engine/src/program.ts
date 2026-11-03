import { stripTypeScriptTypes } from 'node:module';
import { getQuickJS, type QuickJSDeferredPromise, type QuickJSHandle } from 'quickjs-emscripten';

export interface ProgramBinding {
  global: string;
  functions: Record<string, (args: unknown) => Promise<unknown>>;
  errorClass?: { name: string; memberNameProperty: string };
}
export interface ProgramSpec {
  program: string;
  bindings: ProgramBinding[];
  timeoutMs: number;
  signal?: AbortSignal;
}
export interface ProgramResult {
  value?: unknown;
  logs: string[];
  error?: {
    kind:
      | 'exception'
      | 'timeout'
      | 'abort'
      | 'invalid-output'
      | 'output-limit'
      | 'protocol'
      | 'worker-exit';
    message: string;
  };
}
const outputLimit = 512 * 1024;

// This TypeScript function is also installed in the interpreter from its compiled source.
function makeEncoder() {
  const descriptors = Object.getOwnPropertyDescriptors,
    keys = Reflect.ownKeys,
    array = Array.isArray;
  const prototype = Object.getPrototypeOf,
    plain = Object.prototype,
    stringify = JSON.stringify;
  return (input: unknown) => {
    const seen = new Set<object>();
    let nodes = 0;
    const copy = (value: unknown, depth: number): unknown => {
      if (++nodes > 100000 || depth > 64) throw new Error('JSON structure limit');
      if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value !== 'object' || !value || seen.has(value))
        throw new Error('Value is not lossless JSON');
      const isArray = array(value);
      if (!isArray && prototype(value) !== plain && prototype(value) !== null)
        throw new Error('Only plain JSON objects are supported');
      seen.add(value);
      const fields = descriptors(value),
        own = keys(fields);
      const result: unknown[] | Record<string, unknown> = isArray ? [] : Object.create(null);
      for (const key of own) {
        if (isArray && key === 'length') continue;
        const field = fields[key as string];
        if (typeof key !== 'string' || !field || !field.enumerable || !('value' in field))
          throw new Error('JSON properties must be enumerable data');
        if (
          isArray &&
          (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= (value as unknown[]).length)
        )
          throw new Error('Array has non-JSON properties');
        Object.defineProperty(result, key, {
          value: copy(field.value, depth + 1),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      if (isArray && Object.keys(result).length !== (value as unknown[]).length)
        throw new Error('Sparse arrays are not lossless JSON');
      seen.delete(value);
      return result;
    };
    return stringify(copy(input, 0));
  };
}
const encode = makeEncoder();
interface Descriptor {
  global: string;
  names: string[];
  errorClass?: ProgramBinding['errorClass'];
}
function installEnvironment(definitions: Descriptor[], serialize: (value: unknown) => string) {
  const globals = globalThis as unknown as Record<string, unknown>;
  const invoke = globals.__dabanInvoke as (
    global: string,
    name: string,
    json: string,
  ) => Promise<{ ok: boolean; value?: unknown; message?: string }>;
  const emit = globals.__dabanLog as (text: string) => unknown;
  const parse = JSON.parse,
    define = Object.defineProperty;
  define(globals, '__dabanParse', { value: parse });
  define(globals, '__dabanFinish', {
    value: (value: unknown) => {
      try {
        return value === undefined
          ? serialize({ hasValue: false })
          : serialize({ hasValue: true, value });
      } catch {
        const error = new Error('Completion is not lossless JSON');
        error.name = 'PTCOutputError';
        throw error;
      }
    },
  });
  define(globals, 'console', {
    value: Object.freeze({
      log: (...values: unknown[]) =>
        emit(
          values.map((value) => (typeof value === 'string' ? value : serialize(value))).join(' '),
        ),
    }),
  });
  const classes = new Map<string, new (message: string) => Error>();
  for (const definition of definitions) {
    const contract = definition.errorClass;
    if (contract && !classes.has(contract.name)) {
      const errorName = contract.name;
      const Constructor = class extends Error {
        constructor(message: string) {
          super(message);
          this.name = errorName;
        }
      };
      classes.set(contract.name, Constructor);
      define(globals, contract.name, { value: Constructor });
    }
    const namespace = Object.create(null) as Record<string, unknown>;
    for (const name of definition.names)
      define(namespace, name, {
        enumerable: true,
        value: async (args: unknown = {}) => {
          const outcome = await invoke(definition.global, name, serialize(args));
          if (outcome.ok) return outcome.value;
          const Constructor = contract ? classes.get(contract.name)! : Error;
          const error = new Constructor(outcome.message ?? 'Binding failed');
          if (contract)
            define(error, contract.memberNameProperty, { value: name, enumerable: true });
          throw error;
        },
      });
    define(globals, definition.global, { value: Object.freeze(namespace) });
  }
}

export async function runProgram(spec: ProgramSpec): Promise<ProgramResult> {
  const logs: string[] = [];
  if (spec.signal?.aborted) return { logs, error: { kind: 'abort', message: 'Program cancelled' } };
  const wasm = await getQuickJS();
  if (spec.signal?.aborted) return { logs, error: { kind: 'abort', message: 'Program cancelled' } };
  const runtime = wasm.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  runtime.removeModuleLoader();
  const vm = runtime.newContext();
  const deferred = new Set<QuickJSDeferredPromise>();
  let active = true,
    traffic = 0,
    bytes = 0,
    cpu = 0,
    sliceEnd = Date.now() + 100;
  let fault: ProgramResult['error'];
  let wake: (() => unknown) | undefined;
  let promise: QuickJSHandle | undefined, parser: QuickJSHandle | undefined;
  const deadline = Date.now() + spec.timeoutMs;
  const signalWake = () => {
    wake?.();
    wake = undefined;
  };
  const timer = setTimeout(() => {
    fault = { kind: 'timeout', message: 'Program deadline reached' };
    signalWake();
  }, spec.timeoutMs);
  spec.signal?.addEventListener('abort', signalWake, { once: true });
  runtime.setInterruptHandler(
    () => !!spec.signal?.aborted || Date.now() >= Math.min(deadline, sliceEnd) || cpu >= 1000,
  );
  const slice = <T>(operation: () => T) => {
    sliceEnd = Date.now() + 100;
    const start = Date.now();
    try {
      return operation();
    } finally {
      cpu += Date.now() - start;
    }
  };
  const message = (value: unknown) =>
    value && typeof value === 'object' && 'message' in value
      ? String(value.message).slice(0, 2000)
      : String(value).slice(0, 2000);
  try {
    const functions = new Map(
      spec.bindings.map((binding) => [binding.global, new Map(Object.entries(binding.functions))]),
    );
    vm.newFunction('__dabanLog', (handle) => {
      const text = vm.getString(handle);
      bytes += Buffer.byteLength(text);
      if (bytes > outputLimit || logs.length >= 1024)
        fault = { kind: 'output-limit', message: 'Program output limit reached' };
      else logs.push(text);
      return vm.undefined;
    }).consume((handle) => vm.setProp(vm.global, '__dabanLog', handle));
    vm.newFunction('__dabanInvoke', (globalHandle, nameHandle, jsonHandle) => {
      if (++traffic > 256 || deferred.size >= 64) {
        fault = { kind: 'protocol', message: 'Program binding traffic limit reached' };
        return { error: vm.newError(fault.message) };
      }
      const global = vm.getString(globalHandle),
        name = vm.getString(nameHandle),
        json = vm.getString(jsonHandle);
      const operation = functions.get(global)?.get(name);
      if (!operation || Buffer.byteLength(json) > outputLimit)
        return { error: vm.newError('Invalid binding or arguments') };
      let args: unknown;
      try {
        args = JSON.parse(json);
      } catch {
        return { error: vm.newError('Invalid JSON arguments') };
      }
      const pending = vm.newPromise();
      deferred.add(pending);
      const settle = (value: unknown) => {
        if (!active) return;
        const text = encode(value);
        if (Buffer.byteLength(text) > 8 * 1024 * 1024)
          throw new Error('Binding result exceeds interpreter capacity');
        vm.newString(text).consume((input) => {
          const parsed = slice(() => vm.callFunction(parser!, vm.undefined, input));
          if (parsed.error) {
            pending.reject(parsed.error);
            parsed.error.dispose();
          } else {
            pending.resolve(parsed.value);
            parsed.value.dispose();
          }
        });
      };
      Promise.resolve()
        .then(() => operation(args))
        .then(
          (value) => settle({ ok: true, value }),
          (error: unknown) =>
            settle({
              ok: false,
              message: error instanceof Error ? error.message : 'Binding failed',
            }),
        )
        .catch((error: unknown) => {
          if (active) fault = { kind: 'protocol', message: message(error) };
        })
        .finally(() => {
          if (active) {
            deferred.delete(pending);
            pending.dispose();
            signalWake();
          }
        })
        .catch(() => undefined);
      return pending.handle;
    }).consume((handle) => vm.setProp(vm.global, '__dabanInvoke', handle));
    const definitions = spec.bindings.map((binding) => ({
      global: binding.global,
      names: Object.keys(binding.functions),
      ...(binding.errorClass ? { errorClass: binding.errorClass } : {}),
    }));
    const bootstrap = slice(() =>
      vm.evalCode(
        `(${installEnvironment.toString()})(${JSON.stringify(definitions)}, (${makeEncoder.toString()})())`,
      ),
    );
    if (bootstrap.error) {
      const error = vm.dump(bootstrap.error);
      bootstrap.error.dispose();
      throw new Error(message(error));
    }
    bootstrap.value.dispose();
    parser = vm.getProp(vm.global, '__dabanParse');
    const source = stripTypeScriptTypes(
      `async function __dabanMain(){\n${spec.program}\n}\n__dabanMain().then(globalThis.__dabanFinish)`,
      { mode: 'strip' },
    );
    const evaluated = slice(() => vm.evalCode(source, 'program.ts'));
    if (evaluated.error) {
      const error = vm.dump(evaluated.error);
      evaluated.error.dispose();
      throw new Error(message(error));
    }
    promise = evaluated.value;
    for (;;) {
      if (spec.signal?.aborted)
        return { logs, error: { kind: 'abort', message: 'Program cancelled' } };
      if (fault) return { logs, error: fault };
      if (Date.now() >= deadline || cpu >= 1000)
        return {
          logs,
          error: { kind: 'timeout', message: 'Program CPU or elapsed-time budget reached' },
        };
      const state = vm.getPromiseState(promise);
      if (state.type === 'fulfilled') {
        const text = vm.getString(state.value);
        state.value.dispose();
        if (bytes + Buffer.byteLength(text) > outputLimit)
          return { logs, error: { kind: 'output-limit', message: 'Program output limit reached' } };
        const result = JSON.parse(text) as { hasValue: boolean; value?: unknown };
        return { logs, ...(result.hasValue ? { value: result.value } : {}) };
      }
      if (state.type === 'rejected') {
        const error: unknown = vm.dump(state.error);
        state.error.dispose();
        return {
          logs,
          error: {
            kind:
              error &&
              typeof error === 'object' &&
              'name' in error &&
              error.name === 'PTCOutputError'
                ? 'invalid-output'
                : 'exception',
            message: message(error),
          },
        };
      }
      if (runtime.hasPendingJob()) {
        const executed = slice(() => runtime.executePendingJobs(1));
        if (executed.error) {
          const error = vm.dump(executed.error);
          executed.error.dispose();
          throw new Error(message(error));
        }
        await new Promise((resolve) => setImmediate(resolve));
      } else
        await new Promise((resolve) => {
          wake = () => resolve(undefined);
        });
    }
  } catch (error) {
    await new Promise((resolve) => setImmediate(resolve));
    return {
      logs,
      error: {
        kind: spec.signal?.aborted
          ? 'abort'
          : Date.now() >= deadline || cpu >= 100 || message(error).includes('interrupted')
            ? 'timeout'
            : 'exception',
        message: message(error),
      },
    };
  } finally {
    active = false;
    clearTimeout(timer);
    spec.signal?.removeEventListener('abort', signalWake);
    for (const pending of deferred) pending.dispose();
    promise?.dispose();
    parser?.dispose();
    vm.dispose();
    runtime.dispose();
  }
}
