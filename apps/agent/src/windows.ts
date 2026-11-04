import { execFile } from 'node:child_process';
import { constants } from 'node:os';
import path from 'node:path';
import { getSystemErrorMap, promisify } from 'node:util';
import type { WindowsAcceleration } from '@daban/protocol';
import { sshEnvironment } from './ssh.js';

interface RunOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
  windowsHide: boolean;
  maxBuffer: number;
}
type ProbeOutput = { stdout: string; stderr?: string };
type Run = (program: string, args: string[], options: RunOptions) => Promise<ProbeOutput>;
const execute = promisify(execFile);
const probeTimeout = 15000;
const processCodes = new Set([
  ...Array.from(getSystemErrorMap().values(), ([name]) => name),
  'ABORT_ERR',
  'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  'ERR_INVALID_ARG_TYPE',
  'ERR_INVALID_ARG_VALUE',
]);
const processSignals = new Set(Object.keys(constants.signals));
function probeCause(
  error: unknown,
  failure: 'process' | 'json' | 'shape',
  elapsedMs: number,
  output?: ProbeOutput,
) {
  const detail = error && typeof error === 'object' ? (error as Record<string, unknown>) : {};
  const stdout = output?.stdout ?? detail.stdout;
  const stderr = output?.stderr ?? detail.stderr;
  const text =
    typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString('utf8') : '';
  const phases = [
    ...text.matchAll(
      /^DABAN_WINDOWS_PROBE:(module|cpu|feature|capability)(?::([0-9]{1,8}))?\r?$/gm,
    ),
  ]
    .slice(-4)
    .map((match) => ({
      stage: match[1],
      elapsedMs: match[2] === undefined ? null : Number(match[2]),
    }));
  const cim = /^DABAN_WINDOWS_CIM:([0-9]|[1-5][0-9]|6[0-4])\r?$/m.exec(text)?.[1];
  const bytes = (value: unknown) =>
    typeof value === 'string'
      ? Buffer.byteLength(value)
      : Buffer.isBuffer(value)
        ? value.length
        : null;
  const completed = output !== undefined;
  return {
    failure,
    stage: phases.at(-1)?.stage ?? 'launch',
    phases,
    elapsedMs,
    timeoutMs: probeTimeout,
    deadlineReached: elapsedMs >= probeTimeout,
    // execFile reports killed/signal, but elapsed time alone is not an explicit timeout flag.
    timedOut: completed
      ? false
      : typeof detail.timedOut === 'boolean'
        ? detail.timedOut
        : detail.code === 'ETIMEDOUT'
          ? true
          : null,
    code:
      typeof detail.code === 'string'
        ? processCodes.has(detail.code)
          ? detail.code
          : 'other'
        : null,
    exitCode: completed
      ? 0
      : typeof detail.code === 'number' &&
          Number.isInteger(detail.code) &&
          detail.code >= -2147483648 &&
          detail.code <= 4294967295
        ? detail.code
        : null,
    signal: completed
      ? null
      : typeof detail.signal === 'string'
        ? processSignals.has(detail.signal)
          ? detail.signal
          : 'other'
        : null,
    killed: completed ? false : typeof detail.killed === 'boolean' ? detail.killed : null,
    stdoutBytes: bytes(stdout),
    stderrBytes: bytes(stderr),
    maxBufferBytes: 65536,
    cimCode: cim === undefined ? null : Number(cim),
  };
}
function powershellEnvironment() {
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const names = [
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramFiles',
    'ProgramFiles(x86)',
    'ProgramW6432',
    'COMSPEC',
    'COMPUTERNAME',
    'HOMEDRIVE',
    'HOMEPATH',
    'PSModulePath',
  ];
  // CIM requires Windows profile/program metadata as well as SSH's minimal environment.
  // Keep registered module locations; replacing PSModulePath can stall CIM module initialization.
  // Command lookup remains limited to Windows system directories, and model keys stay excluded.
  return {
    ...sshEnvironment(),
    ...Object.fromEntries(
      names.flatMap((name) =>
        typeof process.env[name] === 'string' ? [[name, process.env[name]!]] : [],
      ),
    ),
    Path: [system, path.join(system, 'Wbem'), path.join(system, 'WindowsPowerShell/v1.0')].join(
      ';',
    ),
  };
}
const probeScript = `
$ErrorActionPreference='Stop'
# Optional timing must not prevent the original observation in restricted PowerShell environments.
$probeClock=$null
try { $probeClock=[System.Diagnostics.Stopwatch]::StartNew() } catch {}
function Write-DabanProbeStage([string]$stage) {
$marker='DABAN_WINDOWS_PROBE:' + $stage
if ($null -ne $probeClock) { $marker += ':' + $probeClock.ElapsedMilliseconds }
[Console]::Error.WriteLine($marker)
}
Write-DabanProbeStage 'module'
Import-Module "$PSHOME/Modules/CimCmdlets/CimCmdlets.psd1"
Write-DabanProbeStage 'cpu'
$cpu=Get-CimInstance Win32_Processor -Property Architecture,VirtualizationFirmwareEnabled | Select-Object -First 1
Write-DabanProbeStage 'feature'
try {
$feature=Get-CimInstance Win32_OptionalFeature -Filter "Name='HypervisorPlatform'" -Property InstallState
} catch {
[Console]::Error.WriteLine('DABAN_WINDOWS_CIM:' + [int]$_.Exception.NativeErrorCode)
throw
}
Write-DabanProbeStage 'capability'
$present=$false
try {
Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class DabanWhp { [DllImport("WinHvPlatform.dll")] public static extern int WHvGetCapability(uint code, out int capability, uint size, out uint written); }'
$capability=0; [uint32]$written=0
$result=[DabanWhp]::WHvGetCapability(0,[ref]$capability,4,[ref]$written)
$present=($result -eq 0 -and $capability -ne 0)
} catch { $present=$false }
[ordered]@{architecture=[int]$cpu.Architecture;firmware=[bool]$cpu.VirtualizationFirmwareEnabled;feature=[bool]($feature.InstallState -eq 1);hypervisor=[bool]$present} | ConvertTo-Json -Compress
`;

export class WindowsHost {
  private probing?: Promise<WindowsAcceleration>;
  constructor(private readonly dependencies: { run?: Run } = {}) {}
  async owns(pid: number, image: string): Promise<boolean | undefined> {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffffffff || !path.isAbsolute(image))
      throw Error('QEMU_CONFIG_INVALID');
    const program = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const script = `$ErrorActionPreference='Stop'\n$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'\n[ordered]@{exists=[bool]$p;image=if($p.ExecutablePath){[string]$p.ExecutablePath}else{$null}} | ConvertTo-Json -Compress`;
    try {
      const result = await (
        this.dependencies.run ??
        ((binary, args, options) => execute(binary, args, { ...options, encoding: 'utf8' }))
      )(
        program,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { env: powershellEnvironment(), timeout: 15000, windowsHide: true, maxBuffer: 65536 },
      );
      const value: unknown = JSON.parse(result.stdout.trim());
      if (
        !value ||
        typeof value !== 'object' ||
        !('exists' in value) ||
        typeof value.exists !== 'boolean' ||
        !('image' in value)
      )
        return undefined;
      if (!value.exists) return false;
      if (typeof value.image !== 'string' || !path.isAbsolute(value.image)) return undefined;
      return path.resolve(value.image).toLowerCase() === path.resolve(image).toLowerCase();
    } catch {
      return undefined;
    }
  }
  async enable() {
    const program = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const child = Buffer.from(
      "$ErrorActionPreference='Stop'; try { Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All -NoRestart | Out-Null; exit 0 } catch { exit 1 }",
      'utf16le',
    ).toString('base64');
    const script = `$ErrorActionPreference='Stop'
try {
$p=Start-Process -FilePath '${program.replaceAll("'", "''")}' -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand','${child}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru
$p.WaitForExit(); $p.Refresh()
if ($p.ExitCode -ne 0) { throw 'FeatureEnableFailed' }
'{"result":"enabled"}'
} catch { if ($_.Exception.NativeErrorCode -eq 1223) { '{"result":"cancelled"}' } else { '{"result":"failed"}' } }`;
    let value: unknown;
    try {
      const result = await (
        this.dependencies.run ??
        ((binary, args, options) => execute(binary, args, { ...options, encoding: 'utf8' }))
      )(
        program,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { env: powershellEnvironment(), timeout: 180000, windowsHide: true, maxBuffer: 65536 },
      );
      value = JSON.parse(result.stdout.trim());
    } catch {
      throw Error('QEMU_FEATURE_ENABLE_FAILED');
    }
    if (value && typeof value === 'object' && 'result' in value && value.result === 'cancelled')
      throw Error('QEMU_ELEVATION_CANCELLED');
    if (!value || typeof value !== 'object' || !('result' in value) || value.result !== 'enabled')
      throw Error('QEMU_FEATURE_ENABLE_FAILED');
  }
  probe() {
    if (!this.probing) {
      const started = Date.now();
      // Cold CIM/.NET startup is expensive; concurrent status observers must share one process.
      this.probing = this.observe()
        .then((value) => {
          console.info('[windows-probe]', Date.now() - started, value);
          return value;
        })
        .catch((error: unknown) => {
          console.error('[windows-probe]', Date.now() - started, 'QEMU_HOST_UNAVAILABLE');
          throw error;
        })
        .finally(() => {
          this.probing = undefined;
        });
    }
    return this.probing;
  }
  private async observe(): Promise<WindowsAcceleration> {
    const started = performance.now();
    let output: ProbeOutput | undefined;
    let failure: 'process' | 'json' | 'shape' = 'process';
    const program = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    try {
      output = await (
        this.dependencies.run ??
        ((binary, args, options) => execute(binary, args, { ...options, encoding: 'utf8' }))
      )(
        program,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(probeScript, 'utf16le').toString('base64'),
        ],
        {
          env: powershellEnvironment(),
          timeout: probeTimeout,
          windowsHide: true,
          maxBuffer: 65536,
        },
      );
      failure = 'json';
      const value: unknown = JSON.parse(output.stdout.trim());
      failure = 'shape';
      if (
        !value ||
        typeof value !== 'object' ||
        !('architecture' in value) ||
        typeof value.architecture !== 'number' ||
        !('firmware' in value) ||
        typeof value.firmware !== 'boolean' ||
        !('feature' in value) ||
        typeof value.feature !== 'boolean' ||
        !('hypervisor' in value) ||
        typeof value.hypervisor !== 'boolean'
      )
        throw Error('QEMU_HOST_UNAVAILABLE');
      if (value.architecture !== 9) return 'unsupported';
      if (value.hypervisor && value.feature) return 'ready';
      if (!value.firmware) return 'firmware';
      return value.feature ? 'restart' : 'disabled';
    } catch (error: unknown) {
      const cause = probeCause(error, failure, Math.round(performance.now() - started), output);
      console.error('[windows-probe-stage]', cause.stage);
      if (cause.cimCode !== null) console.error('[windows-probe-cim]', String(cause.cimCode));
      // Propagate only this closed cause: raw exec errors can contain cmd, paths and private stderr.
      throw new Error('QEMU_HOST_UNAVAILABLE', { cause });
    }
  }
}
