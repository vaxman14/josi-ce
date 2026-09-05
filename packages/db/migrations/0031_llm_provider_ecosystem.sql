-- Josi CE 0031: broader model-provider ecosystem.
alter table llm_providers drop constraint if exists llm_providers_provider_check;
alter table llm_providers add constraint llm_providers_provider_check check (
  provider in (
    'openai', 'anthropic', 'xai', 'openai_compatible',
    'openai_subscription', 'anthropic_subscription',
    'gemini', 'deepseek', 'qwen', 'mistral', 'kimi', 'zhipu', 'cohere',
    'openrouter', 'minimax', 'baidu', 'hunyuan', 'azure_openai',
    'aws_bedrock', 'vertex_ai'
  )
);
