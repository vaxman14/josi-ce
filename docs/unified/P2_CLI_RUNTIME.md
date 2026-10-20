# Subscription CLI Vault integration constraints

Source inspection and official documentation review, 19–20 October 2026. Codex's canonical storage and supervised runtime are now assembled in source as described below. Migration, exceptional recovery and live acceptance remain open; this is not a secret-store exemption or a completed P2 claim. No personal credential files or Keychain items were read.

## Codex

The bundled pin is 0.152.0. Its packaged source (`codex-rs/login/src/auth/storage.rs`) locates file-backed authentication in `CODEX_HOME`, writes the vendor auth object with owner-only Unix mode, and owns its format. [OpenAI's authentication documentation](https://learn.chatgpt.com/docs/auth) describes file/keyring/auto/ephemeral storage. [Its trusted automation guide](https://learn.chatgpt.com/docs/auth/ci-cd-auth) requires preserving the refreshed auth cache and serializing use of a shared login. Josi must not clone a refreshable credential into concurrent jobs or reseed it from an older version. The official CLI continues to perform sign-in/refresh; Josi does not implement the provider's OAuth endpoint.

Planned lifecycle: a Josi-owned login produces the canonical Vault artifact; a bounded, exclusive runtime claim projects it into a private Josi-owned CLI home; refreshed material is committed back to the exact current Vault identity before another run can use it. Explicit file storage and an isolated runtime home must prevent fallback to a personal store. Migration must identify only the old Josi service directory and preserve/reconcile its newest state. No personal-profile search/import is authorized by this design.

Still required: crash/partial-write handling, owner/symlink containment, serialization across API/worker processes, lock/stop cancellation, cleanup after restart, reconfiguration/logout fencing, and recoverable write-back when a token refresh races a Vault lock or storage outage. An encrypted pending result, if used, must be a Vault-owned record with bounded write-back authority, never another canonical store or permission to continue execution. If the latest refresh cannot be recovered, report reconnection rather than replay an older cache.

## Claude Code

The bundled pin is 2.1.258. [Anthropic's authentication documentation](https://code.claude.com/docs/en/authentication) says macOS uses Keychain and that `CLAUDE_CONFIG_DIR` also namespaces its Keychain identity. Changing that directory alone does not establish a file-only, Vault-governed lifecycle. Josi must not force a Keychain failure or read a personal Keychain to work around it.

[The environment-variable reference](https://code.claude.com/docs/en/env-vars) documents `CLAUDE_CODE_OAUTH_TOKEN` and `claude setup-token` for automated environments. This is a candidate Vault-issued runtime route; pinned-binary behavior, token expiry/renewal, login UX and migration from the existing Josi-owned login still need verification before choosing it. No claim is made that the current login implementation already satisfies Vault-only authority.

## Integration boundary

P5 owns startup/shutdown/restart and private runtime directories; P4 owns bounded dispatch authority and cancellation. These dependencies do not close P2: end-to-end Vault authority and preserved/reconciled sign-ins remain release gates. Continue independent rule/permission work without enabling automation or claiming that the current subscription login directories are compliant.

## Canonical refresh claim — 20 October source checkpoint

`CodexCredentialStore` now stores the validated vendor auth cache and its exclusive refresh claim inside one canonical Vault item. API/worker claims serialize with a shared PostgreSQL lock. Each operation checks current Vault authority, the active administrator and their unlocked box. Every mutation advances the item revision. A current consumer may write back only to its exact lease, item, owner and authority epoch; loss of refresh state requires reconnection rather than replaying an earlier cache.

Administrative sign-in/disconnect requires an injected trusted verifier and the exact reviewed item/revision. A lease timeout does not prove that its consumer stopped. Lost-consumer reconciliation requires a separate trusted stop verifier, and is not automatically granted on expiry. A new sign-in receives no previous account cache. Shape validation is tied to the bundled Codex 0.152.0 vendor format and refuses API keys and other authentication modes.

The root TypeScript build passed for this storage checkpoint. No live credential, login, provider request or Vault state was read or changed. The store alone was not wired into login/provider routes; the following checkpoint adds that assembly. No functional suite was run, following the owner's build-first direction. This source is later than `native.12`.

## Supervised Codex consumer — subsequent source checkpoint

Setup, administrator model settings and the production model registry now use the canonical Vault login. The existing response paths and basic response fields remain available to native/web/remote clients. Status reads metadata rather than starting a process or refreshing a token. The native client shows the status detail, sends the reviewed revision when available, and offers interrupted-login reconciliation only when the server can verify its own local stop evidence.

Each run receives a fresh owner-only CLI home created by a separate guardian. It inherits a narrow environment, a private HOME/XDG/TMP location and explicit `cli_auth_credentials_store="file"` / `forced_login_method="chatgpt"` flags. The actual config key intentionally omits `_mode`: that suffix appears in the pinned CLI's internal Rust field, not its TOML key. Credentials and prompt travel over the inherited private IPC pipe, never argv, process environment, ordinary logs or API receipts. The guardian reads back only a bounded, single-link, owner-only regular auth file through a no-follow descriptor, and confirms the original directory inode before cleanup.

The guardian controls the POSIX process group, closes remaining MCP descendants, removes the private home and returns refreshed credentials. The parent commits those credentials to the exact canonical Vault claim before releasing the run. A current-claim check renews a five-second local authority window; parent disconnect, missing renewal, Vault lock, administrator/session loss during login, changed model configuration or local-only mode stops the run. Stop waits for closure; it does not treat sending a signal as success. Unconfirmed cleanup/write-back leaves the claim unavailable rather than falling back to an older login. A known stopped login can be reconciled by an authenticated administrator; a client boolean or expired timer cannot provide that proof.

The production provider has no default legacy-home runner. It does not import or use an operator's terminal login. Old Josi service login files are retained untouched pending the dedicated migration. Until then, this newer source requires signing in through Josi to establish a canonical Vault item. The `native.12` artifact still predates this change.

Compatibility is deliberately bounded. The source refuses hosts with system or managed Codex configuration sources rather than overriding their policy, and repeats presence checks before heartbeat renewal. The bundled CLI can obtain cloud-managed requirements for workspace accounts; the initial execution consumer accepts known personal Free/Plus/Pro plan metadata and refuses other or unknown plans. This metadata check is compatibility screening, not JWT verification; the vendor CLI authenticates. Managed workspace support, policy/account changes during refresh, and pinned-binary integration need acceptance before release. Windows requires a Job Object supervisor and is not silently given a weaker implementation.

The root TypeScript build and full Swift 6 native compilation passed. No CLI, login, provider request, personal credential read, Keychain action, installation or functional suite was run. Required release work remains: migration of only the identified old Josi service cache; restart/hard-kill orphan reconciliation; unsupported/changed managed-policy coverage; account switching and refresh/lock failure acceptance; cross-process API/worker lifecycle acceptance; and Claude's supported Vault-only consumer. The current process-group guardian is not an OS-level guarantee against malicious code escaping its group or an administrator changing the host.
