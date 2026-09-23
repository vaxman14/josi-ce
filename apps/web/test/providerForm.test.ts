import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProviderForm, type ProviderCatalogEntry } from '../src/components/ProviderForm.js';

const chatgpt: ProviderCatalogEntry = {
  kind: 'openai_subscription', label: 'ChatGPT subscription', external: true,
  baseUrlMode: 'none', defaultBaseUrl: null, fields: [], discovery: 'codex',
  modelNoun: 'model', residency: '', docsUrl: '',
};

function renderForm() {
  return renderToStaticMarkup(React.createElement(ProviderForm, {
    busy: false,
    catalog: [chatgpt],
    initialProvider: 'openai_subscription',
    paths: { models: '/admin/llm/models', codexBase: '/admin/llm/subscription', claudeBase: '/admin/llm/subscription/claude' },
    loadSubscriptionInfo: async () => null,
    onSubmit: async () => undefined,
  }));
}

describe('ChatGPT subscription model choice', () => {
  it('shows an explicit Automatic option and a way to list signed-in Codex models', () => {
    const html = renderForm();
    expect(html).toContain('ChatGPT model');
    expect(html).toContain('Automatic (Codex chooses)');
    expect(html).toContain('Show ChatGPT models');
    expect(html).toContain('exact ChatGPT model ID');
  });
});
