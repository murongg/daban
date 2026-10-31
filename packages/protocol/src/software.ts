import { validAgentId } from './id.js';

export interface SoftwarePackage {
  name: string;
  version: string;
}
export interface SoftwarePlan {
  id: string;
  requested: string[];
  targets: SoftwarePackage[];
  packages: SoftwarePackage[];
  source: 'debian';
  createdAt: string;
  expiresAt: string;
  digest: string;
}
export interface SoftwareReceipt {
  plan: SoftwarePlan;
  phase: 'planned' | 'installing' | 'installed' | 'failed' | 'unknown';
  updatedAt: string;
  error?: string;
}
export interface SoftwareState {
  available: boolean;
  items: SoftwareReceipt[];
  error?: string;
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const instant = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 40 &&
  /^\d{4}-\d\d-\d\dT/.test(value) &&
  Number.isFinite(Date.parse(value));
export const isSoftwareName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9+.-]{0,98}[a-z0-9]$/.test(value);
export function isSoftwarePackages(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 8 &&
    value.every(isSoftwareName) &&
    new Set(value).size === value.length
  );
}
export function isSoftwarePackage(value: unknown): value is SoftwarePackage {
  return (
    record(value) &&
    keys(value, ['name', 'version']) &&
    isSoftwareName(value.name) &&
    typeof value.version === 'string' &&
    /^[0-9][A-Za-z0-9.+:~-]{0,199}$/.test(value.version)
  );
}
function packageList(value: unknown, max: number): value is SoftwarePackage[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    value.every(isSoftwarePackage) &&
    new Set(value.map((item) => item.name)).size === value.length
  );
}
export function isSoftwarePlan(value: unknown): value is SoftwarePlan {
  if (
    !record(value) ||
    !keys(value, [
      'id',
      'requested',
      'targets',
      'packages',
      'source',
      'createdAt',
      'expiresAt',
      'digest',
    ]) ||
    !validAgentId(value.id) ||
    !isSoftwarePackages(value.requested) ||
    !packageList(value.targets, 8) ||
    !packageList(value.packages, 200) ||
    value.source !== 'debian' ||
    !instant(value.createdAt) ||
    !instant(value.expiresAt) ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  )
    return false;
  const { targets, requested } = value;
  const interval = Date.parse(value.expiresAt) - Date.parse(value.createdAt);
  return (
    interval > 0 &&
    interval <= 3600000 &&
    targets.length === requested.length &&
    requested.every((name) => targets.some((item) => item.name === name))
  );
}
export function isSoftwareReceipt(value: unknown): value is SoftwareReceipt {
  return (
    record(value) &&
    keys(value, ['plan', 'phase', 'updatedAt', 'error']) &&
    isSoftwarePlan(value.plan) &&
    ['planned', 'installing', 'installed', 'failed', 'unknown'].includes(String(value.phase)) &&
    instant(value.updatedAt) &&
    (value.error === undefined ||
      (typeof value.error === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value.error)))
  );
}
export function isSoftwareState(value: unknown): value is SoftwareState {
  return (
    record(value) &&
    keys(value, ['available', 'items', 'error']) &&
    typeof value.available === 'boolean' &&
    Array.isArray(value.items) &&
    value.items.length <= 50 &&
    value.items.every(isSoftwareReceipt) &&
    new Set(value.items.map((item) => item.plan.id)).size === value.items.length &&
    (value.error === undefined ||
      (typeof value.error === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value.error)))
  );
}
