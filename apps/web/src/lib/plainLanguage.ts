// Saying what happened, rather than printing what the column holds.
//
// LB12: an operator should not have to know that `insufficient_scope` is a
// connector error category, that `needs_reconnect` is a value of
// `connections.status`, or that `awaiting_owner` is a task state. Those are
// database enums. They are correct, they are how the server reasons, and none
// of them is a sentence.
//
// The rule is not "hide it". A person whose connection stopped working needs to
// know WHY, precisely enough to fix it — so every entry below is a plain
// sentence that carries the same information, and the raw value stays available
// in the advanced/detail surfaces where somebody debugging wants it.
//
// The mapping is checked against the database, not maintained by hand: the
// test parses the CHECK constraints in the migrations and fails if a value
// exists that has no plain-language entry. A new state added in SQL therefore
// cannot reach a screen as a bare identifier.

export interface Vocabulary {
  /** Where the values come from, so the test knows what to check against. */
  source: { migrationTable: string; column: string } | { literal: readonly string[] };
  labels: Record<string, string>;
  /** Longer text, where the label alone does not tell somebody what to do. */
  detail?: Record<string, string>;
}

export const VOCABULARIES: Record<string, Vocabulary> = {
  external_channel: {
    source: { literal: ['whatsapp', 'slack', 'signal'] },
    labels: { whatsapp: 'WhatsApp', slack: 'Slack', signal: 'Signal' },
  },

  connection_status: {
    source: { migrationTable: 'connections', column: 'status' },
    labels: {
      active: 'Working',
      needs_reconnect: 'Needs reconnecting',
      revoked: 'Disconnected',
    },
    detail: {
      needs_reconnect: 'The provider stopped accepting the stored permission. Reconnecting fixes it.',
      revoked: 'Access was withdrawn, here or at the provider. Nothing was deleted.',
    },
  },

  connector_error: {
    // A TypeScript union rather than a database column, so it is listed here
    // and the test asserts it against the union's own source file.
    source: { literal: ['revoked', 'expired', 'insufficient_scope', 'rate_limited', 'provider_error', 'network'] },
    labels: {
      revoked: 'Access was withdrawn',
      expired: 'The stored permission expired',
      insufficient_scope: 'A permission was removed',
      rate_limited: 'The provider is asking us to slow down',
      provider_error: 'The provider had a problem',
      network: 'The provider could not be reached',
    },
    detail: {
      insufficient_scope:
        'Somebody removed a permission this needs, at the provider or in Josi. Reconnecting and '
        + 'granting it again fixes it.',
      rate_limited: 'This usually clears on its own. Trying again later is the fix.',
      network: 'Check that this server is allowed to make outbound connections.',
    },
  },

  model_provider: {
    // `llm_providers.provider` carries no CHECK — it is validated in code — so
    // this is asserted against the `ProviderKind` union instead.
    source: {
      literal: [
        'openai', 'anthropic', 'xai', 'openai_compatible',
        'openai_subscription', 'anthropic_subscription',
        'gemini', 'deepseek', 'qwen', 'mistral', 'kimi', 'zhipu', 'cohere',
        'openrouter', 'minimax', 'baidu', 'hunyuan', 'azure_openai', 'aws_bedrock', 'vertex_ai',
      ],
    },
    labels: {
      openai: 'OpenAI',
      anthropic: 'Anthropic',
      xai: 'xAI',
      openai_compatible: 'Your own server',
      openai_subscription: 'Your ChatGPT plan',
      anthropic_subscription: 'Your Claude plan',
      gemini: 'Google Gemini',
      deepseek: 'DeepSeek',
      qwen: 'Alibaba Qwen',
      mistral: 'Mistral',
      kimi: 'Moonshot Kimi',
      zhipu: 'Zhipu GLM',
      cohere: 'Cohere',
      openrouter: 'OpenRouter',
      minimax: 'MiniMax',
      baidu: 'Baidu ERNIE',
      hunyuan: 'Tencent Hunyuan',
      azure_openai: 'Azure AI',
      aws_bedrock: 'AWS Bedrock',
      vertex_ai: 'Google Vertex AI',
    },
    detail: {
      gemini: 'Uses Google’s native Gemini API and its own capability test before activation.',
      deepseek: 'Connects to DeepSeek through its documented OpenAI-compatible API.',
      qwen: 'Connects to Alibaba Qwen through its documented compatible endpoint.',
      mistral: 'Connects to Mistral’s hosted model API.',
      kimi: 'Connects to Moonshot AI’s Kimi API.',
      zhipu: 'Connects to Zhipu AI’s GLM API.',
      cohere: 'Uses Cohere’s native Chat v2 API.',
      openrouter: 'Routes requests through OpenRouter to a model selected by the administrator.',
      minimax: 'Connects to MiniMax through its documented compatible endpoint.',
      baidu: 'Uses an administrator-supplied Baidu deployment endpoint.',
      hunyuan: 'Uses an administrator-supplied Tencent Hunyuan deployment endpoint.',
      azure_openai: 'Uses the Azure deployment and API version configured by the administrator.',
      aws_bedrock: 'Uses the AWS Bedrock deployment endpoint configured by the administrator.',
      vertex_ai: 'Uses the Google Vertex AI deployment endpoint configured by the administrator.',
      openai_compatible: 'A model running on hardware you control. Nothing leaves this server for it.',
      openai_subscription:
        'Runs OpenAI\'s own Codex CLI, signed in as you. Shared across this installation, and it '
        + 'reports no cost, so every usage figure on this path is an estimate.',
      anthropic_subscription:
        'Runs Anthropic\'s own Claude Code CLI, signed in as you. Shared across this installation. '
        + 'It reports real token counts but no cost, because a monthly plan has no per-message '
        + 'price.',
    },
  },

  contact_sync_status: {
    source: { migrationTable: 'contact_sync_origins', column: 'status' },
    labels: {
      idle: 'Syncing',
      syncing: 'Syncing now',
      error: 'Not working',
      paused: 'Paused',
      disconnected: 'Stopped',
    },
    detail: {
      disconnected: 'The contacts it brought are still here, and nothing was changed at the provider.',
    },
  },

  contact_sync_mode: {
    source: { migrationTable: 'contact_sync_origins', column: 'sync_mode' },
    labels: {
      import_only: 'Import only',
      two_way: 'Two-way',
    },
    detail: {
      import_only: 'Contacts come in. Josi never writes back.',
      two_way: 'Changes made here are written back to the provider.',
    },
  },

  contact_source: {
    source: { migrationTable: 'contacts', column: 'source' },
    labels: {
      josi: 'Added here',
      google: 'Google',
      microsoft: 'Microsoft',
      device: 'Your phone',
    },
  },

  contact_conflict: {
    source: { migrationTable: 'contacts', column: 'conflict_state' },
    labels: {
      none: 'In step',
      both_changed: 'Changed in two places',
    },
    detail: {
      both_changed:
        'This changed here and at the provider since the last sync. Nothing was overwritten — '
        + 'edit it here to settle it.',
    },
  },

  task_state: {
    source: { migrationTable: 'tasks', column: 'state' },
    labels: {
      drafting: 'Being worked out',
      awaiting_approval: 'Waiting for you',
      ready: 'Ready to go',
      attempting: 'In progress',
      held: 'Holding',
      awaiting_owner: 'Waiting for you',
      confirmed: 'Confirmed',
      failed: 'Did not work',
      cancelled: 'Cancelled',
      closed: 'Done',
    },
  },

  reminder_status: {
    source: { migrationTable: 'reminders', column: 'status' },
    labels: {
      scheduled: 'Coming up',
      delivered: 'Delivered',
      cancelled: 'Cancelled',
      failed: 'Did not go out',
    },
    detail: {
      failed: 'Josi could not deliver this reminder anywhere. It will not fire again — set a new one.',
    },
  },

  mapping_status: {
    source: { migrationTable: 'folder_mappings', column: 'status' },
    labels: {
      active: 'Syncing',
      paused: 'Paused',
      revoked: 'Removed',
    },
    detail: {
      paused: 'Nothing was deleted. Fix the reason below and syncing resumes.',
      revoked: 'This folder is no longer connected. Everything Josi kept from it has been deleted.',
    },
  },

  document_state: {
    source: { migrationTable: 'documents', column: 'state' },
    labels: {
      discovered: 'Found', extracted: 'Read', indexed: 'Searchable',
      skipped: 'Skipped', blocked: 'Blocked', failed: 'Could not read',
    },
  },

  mapping_paused_reason: {
    source: { migrationTable: 'folder_mappings', column: 'paused_reason' },
    labels: {
      token_expired: 'The connection needs signing in again',
      admin_paused: 'An administrator paused it',
      global_pause: 'All document processing is paused',
      quota_exceeded: 'Your storage limit was reached',
      source_missing: 'The folder could not be found',
    },
    detail: {
      token_expired: 'Reconnect the account on this page and syncing resumes. Nothing was deleted.',
      quota_exceeded: 'Ask your administrator for more room, or unmap something else.',
    },
  },

  telegram_error: {
    source: { migrationTable: 'telegram_outbound', column: 'error_category' },
    labels: {
      unauthorized: 'The bot token was rejected',
      blocked_by_user: 'That person blocked the bot',
      chat_not_found: 'The chat no longer exists',
      rate_limited: 'Telegram is asking us to slow down',
      network: 'Telegram could not be reached',
      too_large: 'The message or file was too big',
      malformed: 'Telegram refused the message',
      unknown: 'Telegram refused it without saying why',
    },
    detail: {
      unauthorized: 'Check the bot token in the Telegram settings; it may have been revoked in BotFather.',
      blocked_by_user: 'Nothing to fix here — they can unblock the bot themselves.',
    },
  },

  telegram_link_status: {
    source: { migrationTable: 'telegram_links', column: 'status' },
    labels: {
      active: 'Linked',
      revoked: 'Unlinked',
    },
  },

  custom_api_status: {
    source: { migrationTable: 'custom_api_connections', column: 'status' },
    labels: {
      unverified: 'Not tested yet',
      active: 'Working',
      needs_attention: 'Needs attention',
    },
    detail: {
      unverified:
        'Nobody has asked this API whether it accepts the stored credential. Josi will not offer it '
        + 'to the assistant until a test succeeds.',
      needs_attention:
        'The last request to this API did not succeed. If the credential was refused, Josi has also '
        + 'switched the connection off until a test succeeds again.',
    },
  },

  custom_api_capability: {
    source: { migrationTable: 'custom_api_endpoints', column: 'capability' },
    labels: {
      read: 'Reads only',
      write: 'Changes something',
      delete: 'Deletes something',
    },
    detail: {
      read: 'Josi may do this on its own. Nothing at the other end is changed.',
      write: 'Josi prepares it and you are shown exactly what would be sent before anything happens.',
      delete: 'Josi prepares it and you are shown exactly what would be sent before anything happens.',
    },
  },

  custom_api_endpoint_source: {
    source: { migrationTable: 'custom_api_endpoints', column: 'source' },
    labels: {
      manual: 'Added by hand',
      openapi: 'Imported from a specification',
    },
  },

  mcp_server_status: {
    source: { migrationTable: 'mcp_servers', column: 'status' },
    labels: {
      unverified: 'Not connected yet',
      active: 'Working',
      needs_attention: 'Needs attention',
    },
    detail: {
      unverified:
        'Nobody has contacted this server yet, so nothing is known about it. Josi will not offer '
        + 'its tools until a connection succeeds.',
      needs_attention:
        'The last exchange with this server did not succeed. If it refused the credential, Josi has '
        + 'also switched the server off until a connection succeeds again.',
    },
  },

  mcp_tool_state: {
    source: { migrationTable: 'mcp_server_tools', column: 'state' },
    labels: {
      new: 'Waiting for you to decide',
      approved: 'Switched on',
      revoked: 'Switched off by you',
      changed: 'Changed since you approved it',
    },
    detail: {
      new: 'Josi found this tool on the server. It is not switched on and the assistant has not '
        + 'been told it exists.',
      changed: 'The server altered this tool\'s name, description or inputs after you approved it, '
        + 'so Josi took it off the list. Read the new version and decide again.',
    },
  },

  mcp_approval_mode: {
    source: { migrationTable: 'mcp_server_tools', column: 'approval_mode' },
    labels: {
      ask: 'Asks you every time',
      auto: 'Runs on its own',
    },
    detail: {
      ask: 'When the assistant wants to use this, it stops and shows you exactly what would be '
        + 'sent. Nothing happens until you agree.',
      auto: 'The assistant may use this without asking. Only choose it for a tool you are sure '
        + 'only reads.',
    },
  },

  mcp_call_status: {
    source: { migrationTable: 'mcp_pending_calls', column: 'status' },
    labels: {
      pending: 'Waiting for you',
      approved: 'Approved',
      denied: 'Declined',
      expired: 'Expired',
      executed: 'Run',
      failed: 'Did not go through',
    },
    detail: {
      expired: 'Nobody answered in time. Ask Josi again and it will prepare a fresh request.',
      failed: 'The server was asked and the tool did not succeed. Nothing else was sent.',
    },
  },

  skill_state: {
    source: { migrationTable: 'skills', column: 'state' },
    labels: {
      review: 'Waiting to be read',
      enabled: 'Switched on',
      disabled: 'Switched off',
    },
    detail: {
      review: 'This is installed and doing nothing at all. Josi will not put instructions in front '
        + 'of the assistant until somebody here has read them and switched it on.',
      disabled: 'It has been read, and it is off. Switching it back on needs no second review '
        + 'unless the skill has changed since.',
    },
  },

  skill_signature: {
    source: { migrationTable: 'skills', column: 'signature_state' },
    labels: {
      builtin: 'Included with Josi',
      verified: 'Signature checked',
      unverified: 'Signed, but not checkable',
      unsigned: 'Not signed',
    },
    detail: {
      builtin: 'This came with the Josi release itself, so its integrity is the release\u2019s.',
      verified: 'The package was signed and the signature matched the key registered for the '
        + 'source it came from.',
      unverified: 'The package carries a signature, but no signing key is registered for that '
        + 'source, so nobody here could check who wrote it. Add the key on the source if the '
        + 'publisher gives you one.',
      unsigned: 'The package is not signed. Josi checked that it matches the digest its catalogue '
        + 'pinned, which catches a package changing under you \u2014 not who wrote it.',
    },
  },

  skill_source_kind: {
    source: { migrationTable: 'skill_sources', column: 'kind' },
    labels: {
      builtin: 'Included with Josi',
      registry: 'Curated registry',
      repository: 'A repository you added',
    },
    detail: {
      builtin: 'The starter catalogue that ships in the release. Nothing from it is installed '
        + 'until somebody installs it.',
    },
  },

  skill_quarantine_reason: {
    source: { migrationTable: 'skill_quarantine', column: 'reason' },
    labels: {
      schema_invalid: 'Not a valid skill package',
      digest_mismatch: 'Not the package the catalogue promised',
      signature_missing: 'Should have been signed and was not',
      signature_invalid: 'The signature did not match',
      capability_unknown: 'Asks for something Josi cannot do',
      instruction_injection: 'Its text tries to override Josi\u2019s own rules',
      too_large: 'Bigger than Josi will read',
    },
    detail: {
      digest_mismatch: 'The catalogue pinned one package and the address served another. That is '
        + 'either a stale catalogue or somebody serving two different things, and Josi cannot tell '
        + 'which.',
      instruction_injection: 'A skill is a runbook for a person to read as well as the assistant. '
        + 'This one was written to the model \u2014 telling it to disregard its rules, to act '
        + 'without asking, or to keep something from you.',
    },
  },

  skill_history_action: {
    source: { migrationTable: 'skill_history', column: 'action' },
    labels: {
      installed: 'Installed',
      updated: 'Updated to a new version',
      reviewed: 'Read and approved',
      enabled: 'Switched on',
      disabled: 'Switched off',
      update_checked: 'Checked for a newer version',
    },
  },

  // Parental Controls. Both lists are TypeScript unions rather than database
  // columns — `module_entitlements` stores dates and a token and derives its
  // state, and an access decision is computed per request — so they are
  // literal here and the test asserts the sentences rather than the schema.
  entitlement_state: {
    source: { literal: ['absent', 'active', 'expired', 'revoked', 'wrong_installation'] },
    labels: {
      absent: 'Not switched on',
      active: 'Switched on',
      expired: 'The licence has run out',
      revoked: 'Switched off here',
      wrong_installation: 'Issued to a different installation',
    },
    detail: {
      absent: 'Nobody has activated a licence for this module, so it is not part of this installation.',
      expired: 'The module stopped working when the licence expired. Nothing was deleted.',
      revoked: 'An administrator switched this off. Families keep their accounts; the controls simply stop applying.',
      wrong_installation:
        'This licence names a different installation of Josi. That usually means a database was restored '
        + 'onto another machine — ask the publisher to reissue it for this one.',
    },
  },

  child_access: {
    source: { literal: ['allowed', 'outside_schedule', 'daily_limit', 'not_managed', 'module_inert'] },
    labels: {
      allowed: 'Josi is available now',
      outside_schedule: 'Outside the agreed hours',
      daily_limit: 'Today’s time is used up',
      not_managed: 'Not a managed account',
      module_inert: 'Parental Controls is not active here',
    },
    detail: {
      outside_schedule: 'Josi will answer again at the next time in the timetable.',
      daily_limit: 'The daily limit has been reached. It starts again tomorrow, in this account’s own timezone.',
      module_inert: 'Without a licence the hours and limits do not apply and nobody can see these conversations.',
    },
  },

  custom_api_call_status: {
    source: { migrationTable: 'custom_api_pending_calls', column: 'status' },
    labels: {
      pending: 'Waiting for you',
      approved: 'Approved',
      denied: 'Declined',
      expired: 'Expired',
      executed: 'Sent',
      failed: 'Did not go through',
    },
    detail: {
      expired: 'Nobody answered in time. Ask Josi again and it will prepare a fresh request.',
      failed: 'The API was asked and did not accept the request. Nothing was changed by Josi.',
    },
  },
};

/** The sentence for a value, or the value itself if nothing knows it.
 *
 * Falling back to the raw value is deliberate. A screen that renders nothing
 * for an unknown state is a screen that hides a state, and the test below means
 * an unknown one cannot reach here in the first place. */
export function plain(vocabulary: keyof typeof VOCABULARIES, value: string | null | undefined): string {
  if (!value) return '';
  return VOCABULARIES[vocabulary]?.labels[value] ?? value;
}

/** The longer explanation, where there is one. */
export function plainDetail(
  vocabulary: keyof typeof VOCABULARIES,
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  return VOCABULARIES[vocabulary]?.detail?.[value] ?? null;
}
