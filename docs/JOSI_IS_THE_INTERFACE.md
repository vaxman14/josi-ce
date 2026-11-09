# Josi is the interface (spec, November 8, 2026)

Written from the owner's words after a day of live testing. This governs how
every setting, connector and permission in Josi is reached. It is not yet
implemented; the implementation plan follows the rules.

## The rules

1. **Ask Josi, for everything.** Any question about Josi's own setup is answered
   by Josi in chat: the address, the redirect URI for Google, which model is
   active, what is connected, what PC control allows. Any change to Josi's
   setup is made by asking Josi. Screens still exist to look at and to revoke,
   but nothing requires visiting one. When Josi cannot answer or act on
   something about herself, that is a bug.

2. **No admin gate for the admin.** Every connector is available to the owner
   by default. The only setup a connector may require is the credential it
   genuinely needs (a client ID and secret for Google or Microsoft, a token
   for GitHub). There is no "allow this connector" step for the owner, ever.

3. **Setup is a conversation.**
   - "Set up Google." → "Great. We need a client ID for OAuth. Do you have it?"
     - Yes → a card opens and the person pastes it. Then the same for the secret.
     - No → "Want the steps to get one?" → the steps, including the exact
       redirect URI to paste into Google's console (Josi knows it).
   - "Connect my GitHub." → "Sure thing, boss. Got a token, or need help getting
     one?" → card → "Done, I see GitHub. Want me to pull something from there?"
   - Josi's tone can be a little sassy. Her facts cannot.

4. **Members ask, the admin approves, in chat and on the phone.**
   - A member says "connect my GitHub." Josi: "You'll need the admin's OK;
     asking now." Every device the admin uses Josi on gets a notification with
     Approve and Deny.
   - Approve → the member is notified in their chat and Josi continues with
     the credential conversation (rule 3). Deny → the member is told plainly.
   - An approval is per person, per connector, once, standing until the admin
     revokes it (also by chat). A pending request expires after a week and
     Josi tells the member so. Narrowing (read-only, which account) is a
     separate ask; approval covers the connector's default capabilities.

5. **Secrets never pass through Josi.** Not read, not copied, not typed by her,
   not even with the person's permission. The person pastes into a card; the
   card posts to the Vault directly; the model sees only "saved". When browser
   control exists, Josi may walk the person to the right page and point, and
   stops there.

6. **Fewer steps, always.** One ask, one card, a password only when the server
   genuinely needs it. Nothing that happens between requests shows on screen.

## Implementation plan (in order)

| Step | What | Where |
|---|---|---|
| A | `josi_setup_status` read tool: address and tunnel; connectors (each provider, available, connected, what it needs, redirect URIs built from the address); models (slots, active, capabilities); SMTP configured or not; PC control summary; version. Always offered to the owner; members see their own connections. | `packages/agent/src/setupStatusTools.ts`, registered in `execute.ts` and `assistantAgent.ts` |
| B | Credential cards: the model asks for a card by provider and field names (`request_credential_card`); the card renders in the native chat (and web) with secure fields that post straight to the connector or Vault route; the model receives only the outcome. Reuses the settings-change proposal rows (`area: credential_card`) so Approvals shows them too. | `settingsChangeTools.ts`, `apps/windows-native/src/Chat.cs` (cards), `Dialogs.cs`, web `Talk.tsx` |
| C | Owner default: connector availability for the owner is always allowed; the member ceiling stays. | `packages/connectors/src/*` capability policy, `connectorRoutes.ts` |
| D | Member requests: `request_connector_access` creates an approval the admin can decide from chat (card), the app (Approvals) or a phone notification; decision notifies the member's thread and continues the flow. | `settingsChangeTools.ts` (new area `member_connector_request`), approvals routes, notifications, mobile push |
| E | Prompt: Josi is told she is the way to configure Josi; never "check your Josi app". | `assistantAgent.ts` |
| F | Show the hidden pages again (Connectors, Apps, Storage) so what Josi talks about is visible. | `Flags.cs` (`Integrations = true`, flipped locally, uncommitted) |

Verification is the same as PC control: a live chat on the installed build,
driven step by step, recorded in the acceptance doc.
