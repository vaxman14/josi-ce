# Subscription CLI Vault integration constraints

Source inspection and official documentation review, 19 October 2026. This records remaining work, not a secret-store exemption or an implemented runtime. Josi's existing subscription login directories remain an open P2 consumer; no personal credential files or Keychain items were read.

## Codex

The bundled pin is 0.152.0. Its packaged source (`codex-rs/login/src/auth/storage.rs`) locates file-backed authentication in `CODEX_HOME`, writes the vendor auth object with owner-only Unix mode, and owns its format. [OpenAI's authentication documentation](https://learn.chatgpt.com/docs/auth) describes file/keyring/auto/ephemeral storage. [Its trusted automation guide](https://learn.chatgpt.com/docs/auth/ci-cd-auth) requires preserving the refreshed auth cache and serializing use of a shared login. Josi must not clone a refreshable credential into concurrent jobs or reseed it from an older version. The official CLI continues to perform sign-in/refresh; Josi does not implement the provider's OAuth endpoint.

Planned lifecycle: a Josi-owned login produces the canonical Vault artifact; a bounded, exclusive runtime claim projects it into a private Josi-owned CLI home; refreshed material is committed back to the exact current Vault identity before another run can use it. Explicit file storage and an isolated runtime home must prevent fallback to a personal store. Migration must identify only the old Josi service directory and preserve/reconcile its newest state. No personal-profile search/import is authorized by this design.

Still required: crash/partial-write handling, owner/symlink containment, serialization across API/worker processes, lock/stop cancellation, cleanup after restart, reconfiguration/logout fencing, and recoverable write-back when a token refresh races a Vault lock or storage outage. An encrypted pending result, if used, must be a Vault-owned record with bounded write-back authority, never another canonical store or permission to continue execution. If the latest refresh cannot be recovered, report reconnection rather than replay an older cache.

## Claude Code

The bundled pin is 2.1.258. [Anthropic's authentication documentation](https://code.claude.com/docs/en/authentication) says macOS uses Keychain and that `CLAUDE_CONFIG_DIR` also namespaces its Keychain identity. Changing that directory alone does not establish a file-only, Vault-governed lifecycle. Josi must not force a Keychain failure or read a personal Keychain to work around it.

[The environment-variable reference](https://code.claude.com/docs/en/env-vars) documents `CLAUDE_CODE_OAUTH_TOKEN` and `claude setup-token` for automated environments. This is a candidate Vault-issued runtime route; pinned-binary behavior, token expiry/renewal, login UX and migration from the existing Josi-owned login still need verification before choosing it. No claim is made that the current login implementation already satisfies Vault-only authority.

## Integration boundary

P5 owns startup/shutdown/restart and private runtime directories; P4 owns bounded dispatch authority and cancellation. These dependencies do not close P2: end-to-end Vault authority and preserved/reconciled sign-ins remain release gates. Continue independent rule/permission work without enabling automation or claiming that the current subscription login directories are compliant.
