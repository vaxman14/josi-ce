// Human-facing model choices for first-run setup.
//
// Provider model IDs are product plumbing. They belong in one curated catalog,
// not in an operator's memory and not duplicated through form components. The
// advanced admin surface may eventually permit a custom ID; onboarding does
// not. Self-hosted servers are the exception because their model names are
// chosen by the operator who runs that server.
export interface ModelChoice {
  id: string;
  label: string;
  note: string;
}

export const SETUP_MODELS: Record<'openai' | 'anthropic' | 'xai', readonly ModelChoice[]> = {
  openai: [
    { id: 'gpt-5.6', label: 'GPT-5.6', note: 'Recommended. Highest general capability.' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', note: 'Balanced capability and cost.' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', note: 'Fast and economical for high-volume work.' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', note: 'Recommended. Balanced capability and speed.' },
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', note: 'Highest capability, with higher cost and latency.' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', note: 'Fastest and lowest-cost Claude option.' },
  ],
  xai: [
    { id: 'grok-4-1-fast-reasoning', label: 'Grok 4.1 Fast (reasoning)', note: 'Recommended for assistant work.' },
    { id: 'grok-4-1-fast-non-reasoning', label: 'Grok 4.1 Fast', note: 'Lower latency for straightforward work.' },
    { id: 'grok-4', label: 'Grok 4', note: 'Original Grok 4 flagship model.' },
  ],
};
