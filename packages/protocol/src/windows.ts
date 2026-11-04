export type QemuMode = 'whpx' | 'tcg';
export type WindowsAcceleration = 'ready' | 'disabled' | 'restart' | 'firmware' | 'unsupported';
export interface WindowsSetup {
  acceleration: WindowsAcceleration;
  mode?: QemuMode;
  memoryMiB: number;
  diskGiB: number;
  requiredBytes?: number;
  availableBytes?: number;
  downloadBytes?: number;
}

export function isWindowsSetup(value: unknown): value is WindowsSetup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).every((key) =>
      [
        'acceleration',
        'mode',
        'memoryMiB',
        'diskGiB',
        'requiredBytes',
        'availableBytes',
        'downloadBytes',
      ].includes(key),
    ) &&
    ['ready', 'disabled', 'restart', 'firmware', 'unsupported'].includes(
      String(item.acceleration),
    ) &&
    (item.mode === undefined || item.mode === 'whpx' || item.mode === 'tcg') &&
    typeof item.memoryMiB === 'number' &&
    Number.isInteger(item.memoryMiB) &&
    item.memoryMiB >= 2048 &&
    item.memoryMiB <= 32768 &&
    typeof item.diskGiB === 'number' &&
    Number.isInteger(item.diskGiB) &&
    item.diskGiB >= 16 &&
    item.diskGiB <= 256 &&
    ['requiredBytes', 'availableBytes', 'downloadBytes'].every(
      (key) =>
        item[key] === undefined ||
        (typeof item[key] === 'number' &&
          Number.isSafeInteger(item[key]) &&
          item[key] >= 0 &&
          item[key] <= 1024 ** 5),
    )
  );
}
