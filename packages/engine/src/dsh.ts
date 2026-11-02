import { createRequire } from 'node:module';

// Legacy Linux composition keeps its default; host applications always supply their bundled SDK.
export const defaultSdkFile =
  '/opt/bot-prototype/dsh/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js';

export function runtimeRequire(sdkFile: string) {
  return createRequire(createRequire(sdkFile).resolve('@deepseek-ai/dsh/package.json'));
}
