import { createHash } from 'node:crypto';
import {
  isPreflightPackageData,
  managedProtocol,
  type PreflightPackage,
  type PreflightPackageData,
  type PreflightReport,
  preflightByteLimit,
  preflightJson,
} from '@daban/protocol';
import { Fault } from './control.js';

export function preflightPackage(
  report: PreflightReport,
  now: number,
  productVersion: string,
): PreflightPackage {
  const connections = new Map<string, string>(),
    tools = new Map<string, string>();
  const platform = process.platform;
  const data: PreflightPackageData = {
    schemaVersion: 1,
    productVersion,
    protocolVersion: managedProtocol,
    platform:
      platform === 'darwin' || platform === 'win32' || platform === 'linux' ? platform : 'unknown',
    ageSeconds: Math.floor(Math.max(0, now - Date.parse(report.checkedAt)) / 1000),
    checks: report.checks.map((check, index) => {
      const requirement = report.requirements[index];
      let aliases: { connectionAlias?: string; toolAlias?: string } = {};
      if (requirement.kind === 'mcp') {
        if (!connections.has(requirement.connection))
          connections.set(requirement.connection, `connection-${connections.size + 1}`);
        const key = preflightJson([requirement.connection, requirement.tool]);
        if (!tools.has(key)) tools.set(key, `tool-${tools.size + 1}`);
        aliases = {
          connectionAlias: connections.get(requirement.connection)!,
          toolAlias: tools.get(key)!,
        };
      }
      // Deliberately project fields: raw owner objects and identifiers must never enter exported bytes.
      return {
        index,
        kind: requirement.kind,
        state: check.state,
        reason: check.reason,
        evidence: check.evidence,
        botAlias: 'bot-1' as const,
        ...aliases,
      };
    }),
  };
  if (!isPreflightPackageData(data)) throw new Fault('PREFLIGHT_INVALID_PACKAGE', 500);
  const json = preflightJson(data);
  if (Buffer.byteLength(json) > preflightByteLimit) throw new Fault('PREFLIGHT_LIMIT', 409);
  return {
    id: report.id,
    reportDigest: report.digest,
    packageDigest: createHash('sha256').update(json).digest('hex'),
    json,
  };
}
