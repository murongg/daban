import type { MessageKey } from './locale';

const errors: Record<string, MessageKey> = {
  VM_CONFIG_INVALID: 'vm.invalid',
  VM_CONFIG_UNSAFE: 'vm.unsafe',
  VM_SETTINGS_BUSY: 'vm.busy',
  VM_PLATFORM_UNSUPPORTED: 'vm.unsupported',
  AGENT_UPDATE_BUSY: 'vm.busy',
  EXECUTOR_HYPERV_UNAVAILABLE: 'vm.hypervUnavailable',
  EXECUTOR_SSH_HOST_KEY: 'vm.hostKeyChanged',
  EXECUTOR_SSH_AUTH: 'vm.sshAuth',
  EXECUTOR_SSH_IDENTITY: 'vm.unsafe',
  EXECUTOR_VM_NOT_CONFIGURED: 'vm.unavailable',
  EXECUTOR_AUTH_UNAVAILABLE: 'vm.unavailable',
  EXECUTOR_LINK_UNAVAILABLE: 'vm.unavailable',
  RECOVERY_TARGET_CHANGED: 'vm.targetChanged',
  AGENT_EXECUTION_CACHE_INVALID: 'vm.targetChanged',
  QEMU_DISK_SPACE: 'setup.windowsDiskSpace',
  QEMU_DOWNLOAD_FAILED: 'setup.windowsDownloadFailed',
  QEMU_BUNDLE_MISSING: 'setup.windowsBundleMissing',
  QEMU_BUNDLE_INVALID: 'setup.windowsIntegrity',
  QEMU_BUNDLE_CHANGED: 'setup.windowsIntegrity',
  QEMU_ASSET_INTEGRITY: 'setup.windowsIntegrity',
  QEMU_ASSET_UNSAFE: 'vm.unsafe',
  QEMU_STORE_UNSAFE: 'vm.unsafe',
  QEMU_IDENTITY_CHANGED: 'vm.targetChanged',
  QEMU_MODE_CHANGED: 'setup.windowsUncertain',
  QEMU_LAUNCH_UNCERTAIN: 'setup.windowsUncertain',
  QEMU_SETUP_UNCERTAIN: 'setup.windowsUncertain',
  QEMU_EXISTING_DISK: 'setup.windowsUncertain',
  QEMU_POWER_BUSY: 'vm.busy',
  QEMU_FEATURE_ENABLE_FAILED: 'setup.windowsEnableFailed',
  QEMU_ELEVATION_CANCELLED: 'setup.windowsEnableFailed',
  QEMU_PLATFORM_UNSUPPORTED: 'setup.windowsUnsupported',
};

export function vmErrorKey(error: unknown) {
  return error instanceof Error
    ? (errors[error.message] ??
        (/^QEMU_[A-Z_]+$/.test(error.message) ? 'setup.windowsFailed' : undefined))
    : undefined;
}
