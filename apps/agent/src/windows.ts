import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { WindowsAcceleration } from '@daban/protocol';
import { sshEnvironment } from './ssh.js';

interface RunOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
  windowsHide: boolean;
  maxBuffer: number;
}
type Run = (program: string, args: string[], options: RunOptions) => Promise<{ stdout: string }>;
const execute = promisify(execFile);
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
[Console]::Error.WriteLine('DABAN_WINDOWS_PROBE:module')
Import-Module "$PSHOME/Modules/CimCmdlets/CimCmdlets.psd1"
[Console]::Error.WriteLine('DABAN_WINDOWS_PROBE:cpu')
$cpu=Get-CimInstance Win32_Processor -Property Architecture,VirtualizationFirmwareEnabled | Select-Object -First 1
[Console]::Error.WriteLine('DABAN_WINDOWS_PROBE:feature')
try {
$feature=Get-CimInstance Win32_OptionalFeature -Filter "Name='HypervisorPlatform'" -Property InstallState
} catch {
[Console]::Error.WriteLine('DABAN_WINDOWS_CIM:' + [int]$_.Exception.NativeErrorCode)
throw
}
[Console]::Error.WriteLine('DABAN_WINDOWS_PROBE:capability')
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
    const program = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
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
          Buffer.from(probeScript, 'utf16le').toString('base64'),
        ],
        { env: powershellEnvironment(), timeout: 15000, windowsHide: true, maxBuffer: 65536 },
      );
      const value: unknown = JSON.parse(result.stdout.trim());
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
      // Never log PowerShell's error text: only these fixed stage markers are public diagnostics.
      const stderr =
        error && typeof error === 'object' && 'stderr' in error && typeof error.stderr === 'string'
          ? error.stderr
          : '';
      const stage = [...stderr.matchAll(/DABAN_WINDOWS_PROBE:(module|cpu|feature|capability)/g)].at(
        -1,
      )?.[1];
      console.error('[windows-probe-stage]', stage ?? 'launch');
      const code = /DABAN_WINDOWS_CIM:([0-9]|[1-5][0-9]|6[0-4])\r?\n/.exec(stderr)?.[1];
      if (code) console.error('[windows-probe-cim]', code);
      throw Error('QEMU_HOST_UNAVAILABLE');
    }
  }
}
