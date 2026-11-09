# macOS catch-up handoff (November 9, 2026)

For the session that brings the Mac app level with Windows. Branch
`redesign/windows-lean-beta` on GitHub holds everything below, pushed. The
Mac redesign itself lives on `redesign/mac-lean-beta` (look, scope,
navigation: `docs/MACOS_LEAN_BETA.md`); this document is about behaviour the
server now offers that the Mac app does not yet show.

Read first: `docs/JOSI_IS_THE_INTERFACE.md` (the rules and the plan, steps A
to H, all built on Windows), then `docs/WINDOWS_PC_CONTROL_LIVE_ACCEPTANCE.md`
(what was driven live and how it behaved).

## The principle the Mac app must keep

Everything is done by asking Josi. Screens are fallbacks. Secrets never pass
through the model: a person types them into a card, the card posts to the
route with the person's own session, the conversation gets a "saved" note.

## Server contracts the Mac app consumes (already live on Windows)

All under `/api`, same auth as today.

### Settings-change proposals and credential cards
- `GET /settings-changes` → `{proposals: [...], policy, superAdmin}`. Each
  proposal: `id, threadId, proposer, mine, scope ('personal'|'administrator'),
  area, sensitive, title, summary, state, createdAt, expiresAt, canApprove,
  canDeny, apply, card`.
  - `area == 'credential_card'`: `card` is `{kind, provider, title, intro,
    fields: [{key, label, type: 'text'|'secret'|'confirm', required,
    placeholder, help}], help: {text, url}, done}`.
  - `area == 'member_connector_request'`: a member asks the owner to allow a
    developer service; the owner approves or denies like any proposal.
- `POST /settings-changes/:id/decide {approve, password?}` → `{ok, state,
  apply: {method, path, body} | null}`. For a credential card the app then
  performs `apply.method apply.path` with `apply.body` (the fixed values)
  merged with the typed values, then `POST /settings-changes/:id/applied
  {ok, error?}`. Special shape: when `apply.body.__shape == 'smtp'` build
  `{expected, system: {...}, communications: {copyFromSystem: true, ...}}`
  as `AppModel.SaveCredentialCard` does in
  `apps/windows-native/src/AppModel.cs`.
- Poll `/settings-changes` right after each reply lands (not on a 30 s timer):
  Windows learned that a card that "is open" must be open within a second.
  Windows reference: `Notifications.cs` (`CheckSettingsChanges`),
  `Dialogs.CredentialCard`, `Assistant.cs` ("Fill in" under Approvals).

### My World
- `GET /my-world` → `{kinds: [spec per kind: kind, label, plural, fields
  [{key,label,secret,hint}], dates [{key,label}]], items: [{id, kind, label,
  fields, dates, secretKeys, secretsSet, createdAt, updatedAt}], memory:
  [{id, itemId, content, source, createdAt}], unlocked}`.
- `POST /my-world/items {kind,label,fields,dates}`, `PUT /my-world/items/:id`,
  `DELETE /my-world/items/:id`, `PUT /my-world/items/:id/sensitivity
  {secretKeys}`.
- Secrets: `PUT /my-world/items/:id/secrets/:key {value}` (no unlock needed),
  `DELETE` the same path, `POST /my-world/items/:id/secrets/:key/reveal`
  (needs the five-minute Vault unlock: `POST /vault/unlock {password}`;
  returns `{value, screenOnly: true}`; show on screen only, never speak it).
- "Josi knows": `POST /my-world/memory {content, itemId?}`, `PUT
  /my-world/memory/:id {content}`, `DELETE /my-world/memory/:id`.
- Windows reference: `apps/windows-native/src/MyWorld.cs` (page built from
  `kinds`), menu entry at the top of the Workspace group, a button in the
  chat bar (`josi.chat.my-world`).

### Setup status, connector requests (no app work)
`josi_setup_status`, `request_connector_access`, `decide_connector_request`,
`revoke_connector_access` are agent tools; they need nothing from the app
beyond the proposal list above. The owner is never gated by the member
ceilings any more (connectors and developer services).

### PC Control and browser (Mac has its own executor)
Windows added, for the extension: presence with `activeOrigin`,
`activeTitle`, `tabs` and `family: 'firefox'`; tools `browser_list_tabs`,
`browser_attach_tab`, `browser_select_option`, `browser_drag`,
`browser_scroll`, `browser_download`, `browser_upload_file`; the native host
accepts store IDs and an override file; the chat card offers "Always allow on
this site". The Mac bridge in `apps/macos-native` must answer the same
`browser.hello` with `attachedTabId: null`, the same poll fields, and the new
command kinds, or those tools will refuse on a Mac. Contract and behaviour:
`docs/BROWSER_EXTENSION_REBUILD_BRIEF.md` and commit `07449b3`.

## What to build on the Mac, in order

1. **Credential card sheet** from `card`: text fields, secret fields as a
   secure field with Paste and Show/Hide, confirm checkboxes; Save performs
   the route and reports `/applied`; Decline and Not now. Open it as soon as a
   proposal with `canApprove` arrives after a reply, and list it under
   Approvals with "Fill in".
2. **Member connector requests** in the same popup and Approvals list: Approve
   performs `apply` (`POST /admin/developer-services/:service/allow`).
3. **My World page** behind the password: items grouped by kind with Add,
   secret fields Set / Show (after unlock) / Clear, Remove, and the "Josi
   knows" list with Forget and Add. Menu entry at the top, a chat-bar button.
4. **Browser bridge parity** with the extension 0.9.0 contract.
5. **Installer and release**: `docs/MACOS_RELEASE.md`; bump to match the
   server version shipped on Windows (1.2.5-preview.16 at the time of writing).

## Verification

The same live loop as Windows: on the installed build ask Josi
"what is my Google redirect URI?", "set up GitHub, I have a token" (card,
paste, save, then "list my repositories"), "I just bought a 2026 Ford
Explorer" (My World, then the plate card), and record each in
`docs/WINDOWS_PC_CONTROL_LIVE_ACCEPTANCE.md` or a Mac twin of it.
