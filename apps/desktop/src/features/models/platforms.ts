import { type ModelApi, type ModelConnection, modelApi } from '@daban/protocol';
import type { MessageKey } from '../../i18n/locale';

interface Platform {
  id: string;
  name: MessageKey;
  baseURL: string;
  api: ModelApi;
}

export const apiOptions = [
  { value: 'openai-completions', label: 'OpenAI Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Claude Messages' },
  { value: 'google-generative-ai', label: 'Gemini GenerateContent' },
] as const satisfies readonly { value: ModelApi; label: string }[];

// Defaults follow vendor API docs; model IDs and regional/account-specific addresses stay explicit.
export const platforms: readonly Platform[] = [
  { id: 'custom', name: 'providers.customApi', baseURL: '', api: 'openai-completions' },
  // https://developers.openai.com/api/reference/overview
  {
    id: 'openai',
    name: 'providers.openai',
    baseURL: 'https://api.openai.com/v1',
    api: 'openai-responses',
  },
  // https://platform.claude.com/docs/en/api/overview
  {
    id: 'claude',
    name: 'providers.claude',
    baseURL: 'https://api.anthropic.com',
    api: 'anthropic-messages',
  },
  // https://ai.google.dev/api
  {
    id: 'gemini',
    name: 'providers.gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    api: 'google-generative-ai',
  },
  // https://docs.x.ai/overview
  { id: 'xai', name: 'providers.grokXai', baseURL: 'https://api.x.ai/v1', api: 'openai-responses' },
  // https://api-docs.deepseek.com/quick_start/agent_integrations/
  {
    id: 'deepseek',
    name: 'providers.deepseek',
    baseURL: 'https://api.deepseek.com/v1',
    api: 'openai-completions',
  },
  // https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope
  {
    id: 'qwen',
    name: 'providers.qwenAlibabaCloudModelStudio',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    api: 'openai-completions',
  },
  // https://platform.kimi.com/docs/api/chat
  {
    id: 'kimi',
    name: 'providers.kimi',
    baseURL: 'https://api.moonshot.cn/v1',
    api: 'openai-completions',
  },
  // https://docs.bigmodel.cn/cn/guide/develop/openai/introduction
  {
    id: 'zhipu',
    name: 'providers.zhipu',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    api: 'openai-completions',
  },
  // https://platform.minimax.cn/docs/api-reference/text-openai-api
  {
    id: 'minimax',
    name: 'providers.minimax',
    baseURL: 'https://api.minimax.cn/v1',
    api: 'openai-completions',
  },
  // https://docs.volcengine.com/docs/ark/base-url-and-authentication
  {
    id: 'ark',
    name: 'providers.doubaoVolcengineArk',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    api: 'openai-completions',
  },
  // https://api-docs.siliconflow.cn/docs/usercases/use-siliconcloud-in-KiloCode
  {
    id: 'siliconflow',
    name: 'providers.siliconflow',
    baseURL: 'https://api.siliconflow.cn/v1',
    api: 'openai-completions',
  },
  // https://openrouter.ai/docs/quickstart
  {
    id: 'openrouter',
    name: 'providers.openrouter',
    baseURL: 'https://openrouter.ai/api/v1',
    api: 'openai-completions',
  },
  // https://cloud.tencent.com/document/product/1729/111007
  {
    id: 'hunyuan',
    name: 'providers.tencentHunyuan',
    baseURL: 'https://api.hunyuan.cloud.tencent.com/v1',
    api: 'openai-completions',
  },
  // https://cloud.baidu.com/doc/qianfan/s/Smovaaszj
  {
    id: 'qianfan',
    name: 'providers.baiduQianfan',
    baseURL: 'https://qianfan.baidubce.com/v2',
    api: 'openai-completions',
  },
  // https://console.groq.com/docs/openai
  {
    id: 'groq',
    name: 'providers.groq',
    baseURL: 'https://api.groq.com/openai/v1',
    api: 'openai-completions',
  },
  // https://docs.together.ai/docs/inference/openai-compatibility
  {
    id: 'together',
    name: 'providers.togetherAi',
    baseURL: 'https://api.together.ai/v1',
    api: 'openai-completions',
  },
];

export function providerIdentity(connection?: Pick<ModelConnection, 'baseURL' | 'api'>) {
  if (!connection) return 'custom';
  try {
    const url = new URL(connection.baseURL);
    if (url.username || url.password || url.search || url.hash) return 'custom';
    const api = modelApi(connection);
    // Labels are editable; only a recognized API destination can claim a vendor mark.
    return (
      platforms.find((platform) => {
        if (!platform.baseURL) return false;
        const endpoint = new URL(platform.baseURL);
        const protocol =
          platform.api === api ||
          (['openai', 'xai'].includes(platform.id) && api === 'openai-completions');
        return (
          protocol &&
          endpoint.origin === url.origin &&
          endpoint.pathname.replace(/\/+$/, '') === url.pathname.replace(/\/+$/, '')
        );
      })?.id || 'custom'
    );
  } catch {
    return 'custom';
  }
}
