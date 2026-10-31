import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export function resolveSdk(owner: string | URL = import.meta.url) {
  const requireSdk = createRequire(owner);
  try {
    const clientFile = requireSdk.resolve('@deepseek-ai/dsh-sdk-client/package.json');
    const runtimeFile = createRequire(clientFile).resolve('@deepseek-ai/dsh/package.json');
    const client: unknown = JSON.parse(readFileSync(clientFile, 'utf8'));
    const runtime: unknown = JSON.parse(readFileSync(runtimeFile, 'utf8'));
    for (const value of [client, runtime]) {
      if (
        !value ||
        typeof value !== 'object' ||
        !('version' in value) ||
        value.version !== '0.2.1-rc.3'
      )
        throw new Error('AGENT_SDK_VERSION_UNSUPPORTED');
    }
    return requireSdk.resolve('@deepseek-ai/dsh-sdk-client');
  } catch (error) {
    if (error instanceof Error && error.message === 'AGENT_SDK_VERSION_UNSUPPORTED') throw error;
    throw new Error('AGENT_SDK_UNAVAILABLE');
  }
}
