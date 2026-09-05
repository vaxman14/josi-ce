import type { ProviderKind } from './types.js';

export interface ProviderDefinition {
  id: ProviderKind;
  label: string;
  transport: 'openai_compatible' | 'anthropic' | 'gemini' | 'cohere' | 'subscription' | 'custom_endpoint';
  baseUrl?: string;
  docsUrl: string;
  note: string;
  configurableBaseUrl?: boolean;
}

/** Versioned provider facts. A provider is advertised only when a real adapter
 * exists; cloud platforms whose auth needs more than an API key remain explicit
 * custom-endpoint entries until their native credential flow is implemented. */
export const PROVIDER_CATALOG: readonly ProviderDefinition[] = [
  { id: 'openai_compatible', label: 'A model on your own hardware', transport: 'custom_endpoint', docsUrl: 'https://github.com/vaxman14/josi-ce', note: 'Ollama, vLLM, LM Studio, LocalAI, or another compatible endpoint.', configurableBaseUrl: true },
  { id: 'openai', label: 'OpenAI', transport: 'openai_compatible', baseUrl: 'https://api.openai.com/v1', docsUrl: 'https://platform.openai.com/docs', note: 'Hosted by OpenAI.' },
  { id: 'anthropic', label: 'Anthropic', transport: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', docsUrl: 'https://docs.anthropic.com', note: 'Native Messages API adapter.' },
  { id: 'xai', label: 'xAI', transport: 'openai_compatible', baseUrl: 'https://api.x.ai/v1', docsUrl: 'https://docs.x.ai', note: 'OpenAI-compatible API.' },
  { id: 'gemini', label: 'Google Gemini', transport: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', docsUrl: 'https://ai.google.dev/gemini-api/docs', note: 'Native Gemini generateContent adapter.' },
  { id: 'deepseek', label: 'DeepSeek', transport: 'openai_compatible', baseUrl: 'https://api.deepseek.com/v1', docsUrl: 'https://api-docs.deepseek.com', note: 'OpenAI-compatible API.' },
  { id: 'qwen', label: 'Alibaba Qwen', transport: 'openai_compatible', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', docsUrl: 'https://www.alibabacloud.com/help/en/model-studio', note: 'International DashScope OpenAI-compatible endpoint.' },
  { id: 'mistral', label: 'Mistral AI', transport: 'openai_compatible', baseUrl: 'https://api.mistral.ai/v1', docsUrl: 'https://docs.mistral.ai', note: 'OpenAI-compatible API.' },
  { id: 'kimi', label: 'Moonshot / Kimi', transport: 'openai_compatible', baseUrl: 'https://api.moonshot.ai/v1', docsUrl: 'https://platform.moonshot.ai/docs', note: 'OpenAI-compatible API.' },
  { id: 'zhipu', label: 'Zhipu GLM', transport: 'openai_compatible', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', docsUrl: 'https://open.bigmodel.cn/dev/api', note: 'OpenAI-compatible API.' },
  { id: 'cohere', label: 'Cohere', transport: 'cohere', baseUrl: 'https://api.cohere.com/v2', docsUrl: 'https://docs.cohere.com', note: 'Native Chat v2 adapter.' },
  { id: 'openrouter', label: 'OpenRouter', transport: 'openai_compatible', baseUrl: 'https://openrouter.ai/api/v1', docsUrl: 'https://openrouter.ai/docs', note: 'OpenAI-compatible multi-provider router.' },
  { id: 'minimax', label: 'MiniMax', transport: 'openai_compatible', baseUrl: 'https://api.minimax.io/v1', docsUrl: 'https://platform.minimax.io/docs', note: 'OpenAI-compatible API.' },
  { id: 'baidu', label: 'Baidu ERNIE', transport: 'custom_endpoint', docsUrl: 'https://cloud.baidu.com/doc/WENXINWORKSHOP', note: 'Use the OpenAI-compatible endpoint issued for your Qianfan deployment.', configurableBaseUrl: true },
  { id: 'hunyuan', label: 'Tencent Hunyuan', transport: 'custom_endpoint', docsUrl: 'https://cloud.tencent.com/document/product/1729', note: 'Use the OpenAI-compatible endpoint issued for your deployment.', configurableBaseUrl: true },
  { id: 'azure_openai', label: 'Azure AI / Azure OpenAI', transport: 'custom_endpoint', docsUrl: 'https://learn.microsoft.com/azure/ai-services/openai/', note: 'Use your deployment’s OpenAI-compatible base URL.', configurableBaseUrl: true },
  { id: 'aws_bedrock', label: 'AWS Bedrock gateway', transport: 'custom_endpoint', docsUrl: 'https://docs.aws.amazon.com/bedrock/', note: 'Requires an operator-managed OpenAI-compatible Bedrock gateway; Josi does not mislabel API-key auth as native AWS SigV4.', configurableBaseUrl: true },
  { id: 'vertex_ai', label: 'Google Vertex AI gateway', transport: 'custom_endpoint', docsUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs', note: 'Requires an operator-managed OpenAI-compatible Vertex gateway; Josi does not store Google service-account files.', configurableBaseUrl: true },
] as const;

export function providerDefinition(id: string): ProviderDefinition | undefined {
  return PROVIDER_CATALOG.find((provider) => provider.id === id);
}
