// The provider seam.
//
// Everything above this line — the probe, the registry, and eventually the
// assistant — talks to LlmProvider. Only the adapters know what an OpenAI or
// Anthropic payload looks like, and neither shape is allowed past here.

export type ProviderKind = 'openai' | 'anthropic' | 'xai' | 'openai_compatible';

/** Providers that send request content off this server. `openai_compatible`
 * is absent on purpose: it points at whatever the operator runs, which is the
 * self-hosted path. */
export const EXTERNAL_PROVIDERS: readonly ProviderKind[] = ['openai', 'anthropic', 'xai'];

export function isExternalProvider(kind: string): boolean {
  return (EXTERNAL_PROVIDERS as readonly string[]).includes(kind);
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  messages: ChatMessage[];
  system?: string;
  tools?: ToolDefinition[];
  /** Ask for a JSON object back. Providers differ wildly in how well they
   * honour this, which is exactly why the probe checks it. */
  jsonMode?: boolean;
  maxTokens?: number;
  temperature?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  /** Wall-clock time for the call, recorded for self-hosted endpoints where
   * latency is the only cost signal there is. */
  latencyMs: number;
  /** What the provider said it charged, when it says anything at all. Almost
   * nobody does, which is why `estimated` exists downstream. */
  reportedCostUsd?: number;
}

export class LlmError extends Error {
  /** The credential is wrong or revoked — reconnecting fixes it, retrying does
   * not. */
  needsReconfiguration = false;
  /** Rate limited or a transient server error. A fallback may be tried. */
  retryable = false;
  status?: number;

  constructor(message: string, init: Partial<Pick<LlmError, 'needsReconfiguration' | 'retryable' | 'status'>> = {}) {
    super(message);
    Object.assign(this, init);
  }
}

export interface LlmProvider {
  kind: ProviderKind;
  model: string;
  /** True when this provider sends content off the server. */
  external: boolean;
  chat(request: ChatRequest): Promise<ChatResponse>;
}

// ------------------------------------------------------------- capabilities

/** What a model was actually observed to do. Every field starts unknown and is
 * only set by a probe that ran — nothing here is inferred from the model name,
 * because a name is a marketing decision and this is a compatibility question. */
export interface Capabilities {
  chat: boolean;
  structuredOutput: boolean;
  toolCalling: boolean;
  /** Context window in tokens, as reported or as demonstrated. Null when the
   * probe could not establish it. */
  contextTokens: number | null;
}

/** Features CE will not offer unless the underlying capability was proven.
 *
 * The mapping is deliberately explicit rather than computed: when a feature is
 * disabled the operator is told which capability was missing, and that sentence
 * has to come from somewhere. */
export interface FeatureGate {
  feature: string;
  requires: keyof Capabilities;
  /** Shown to the operator when the capability is absent. */
  explanation: string;
}

export const FEATURE_GATES: readonly FeatureGate[] = [
  {
    feature: 'assistant_chat',
    requires: 'chat',
    explanation: 'This model did not answer a basic message, so Josi cannot talk to anyone with it.',
  },
  {
    feature: 'task_extraction',
    requires: 'structuredOutput',
    explanation:
      'This model did not return valid JSON when asked, so Josi cannot reliably turn a conversation into a task.',
  },
  {
    feature: 'calendar_tools',
    requires: 'toolCalling',
    explanation:
      'This model does not support tool calling, so Josi cannot check availability or book on your behalf.',
  },
  {
    feature: 'email_tools',
    requires: 'toolCalling',
    explanation:
      'This model does not support tool calling, so Josi cannot search or draft email.',
  },
  {
    feature: 'document_search',
    requires: 'toolCalling',
    explanation:
      'This model does not support tool calling, so Josi cannot search your documents.',
  },
];

export interface DisabledFeature {
  feature: string;
  reason: string;
}

/** Which features are unavailable given what the probe found. */
export function disabledFeatures(capabilities: Capabilities | null): DisabledFeature[] {
  if (!capabilities) {
    // No probe has run. Everything dependent on a model is off — refusing is
    // honest, pretending is not.
    return FEATURE_GATES.map((g) => ({
      feature: g.feature,
      reason: 'No model has been tested yet, so Josi cannot promise this works.',
    }));
  }
  return FEATURE_GATES.filter((g) => !capabilities[g.requires]).map((g) => ({
    feature: g.feature,
    reason: g.explanation,
  }));
}

export function featureAvailable(feature: string, capabilities: Capabilities | null): boolean {
  return !disabledFeatures(capabilities).some((d) => d.feature === feature);
}
