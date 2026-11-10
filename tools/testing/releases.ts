import type { BotRelease } from '../../packages/protocol/src/releases.js';

export function syntheticRelease(version = '1.0.0'): BotRelease {
  return {
    format: 'daban.bot',
    version: 3,
    manifest: {
      templateId: '10000000-0000-4000-8000-000000000001',
      releaseVersion: version,
      summary: '仅用于协议说明的合成助手',
      license: 'UNLICENSED',
      changelog: '初始合成版本。',
      requires: {
        capabilities: ['bot-releases-v1'],
        tools: [],
        model: { toolCalling: true, vision: false },
      },
      derivedFrom: null,
    },
    definition: {
      profile: {
        name: '合成文稿助手',
        instructions: '仅处理用户提供的合成输入。',
        color: 'violet',
      },
      defaultPreferences: '先给结论，再说明依据。',
      skills: [],
      knowledge: [],
    },
  };
}
