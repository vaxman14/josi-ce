# Josi is the interface (spec, November 8, 2026)

Written from the owner's words after a day of live testing. This governs how
every setting, connector and permission in Josi is reached. It is not yet
implemented; the implementation plan follows the rules.

## The principle

Permissions, restrictions and self-hosting are what Josi has. Ease of use is
the moat the owner is building: *all I need to do is ask, and it shall be
given to me.* Every screen is a fallback. A feature that cannot be asked for
and delivered in chat is not finished.

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

7. **Three levels of ask.**
   - Ordinary: done, no card. Opening a program, answering a setup question,
     connecting a service the person may use.
   - Serious (money leaves, something is deleted or sent, security or
     permissions widen): one card stating the exact effect, the person's
     password or Windows Hello, then done.
   - Secrets (card numbers, passwords, tokens, recovery keys): Josi never
     reads, speaks, stores or transcribes them. "Read my card number back" is
     answered with a reveal card: unlocked by the owner's password or Hello,
     shown on screen only, never on voice, only to the person who owns the
     item. Josi may still use a secret on the person's behalf through a
     protected flow (a payment form filled by the Vault, not by her) without
     ever seeing it. Members get the same for their own items only.

8. **"My World": everything about the person, in the Vault, fed by chat.**
   - A button at the top of the menu (and on the chat screen) named **My World**
     (working name; alternatives: About Me; tagline on the page "Who am I?").
     It opens a form tied to the Vault: names, addresses (several), family
     members with names and relationships, cards, passports and IDs, vehicles,
     homes and apartments, each with its dates (bought, registered, renews).
   - Josi fills it from conversation. "I just bought a 2026 Ford Explorer." →
     "That's great, congrats! Added it to your World. Want to give me the plate?
     Is there a loan? Anything else for the car?" Each follow-up that is a
     secret (card number, passport number, VIN, loan account) comes as a
     protected card the person types into; everything else Josi writes herself.
   - What Josi knows versus what she holds: she may know that a thing exists
     and its non-secret facts (a 2026 Ford Explorer, Dana is a daughter, the
     Murrieta address), so she can be useful. She never holds the secret
     fields; those live only in the Vault, shown only on the page behind the
     person's password or Hello (rule 7), never in chat, never on voice.
   - Default field sensitivity per type (card and account numbers, passport
     and ID numbers, VINs and plates, loan numbers are secret; names, models,
     cities, dates are not), adjustable by the person.
   - Two layers, both visible to the person. The Vault holds the record with
     its secrets, behind the password. Josi's memory holds the non-secret
     facts as she learns them ("Roman owns a 2026 Ford Explorer, added Nov 8;
     plate and VIN are in his World"), so in conversation she simply knows,
     and when a secret is needed she names the Vault item without seeing its
     value. The My World page shows a "Josi knows" list of those memory lines,
     and the person can correct or remove any of them there or by asking.
   - **World memory is its own store** (`MyWorld`, separate from general
     memory): written only by the My World flows, read on every turn, never
     touched by the general memory engine's learning, consolidation or
     forgetting. A model mistake in general memory cannot alter or delete a
     World fact; only the person can, from the page or by an explicit ask that
     names the fact. Each line carries the Vault item it came from.
   - Members have their own World; the admin sees nothing of it. A child's
     World can be viewed by a parent only where parental controls say so.

## Implementation plan (in order)

| Step | What | Where |
|---|---|---|
| A | `josi_setup_status` read tool: address and tunnel; connectors (each provider, available, connected, what it needs, redirect URIs built from the address); models (slots, active, capabilities); SMTP configured or not; PC control summary; version. Always offered to the owner; members see their own connections. | `packages/agent/src/setupStatusTools.ts`, registered in `execute.ts` and `assistantAgent.ts` |
| B | Credential cards: the model asks for a card by provider and field names (`request_credential_card`); the card renders in the native chat (and web) with secure fields that post straight to the connector or Vault route; the model receives only the outcome. Reuses the settings-change proposal rows (`area: credential_card`) so Approvals shows them too. | `settingsChangeTools.ts`, `apps/windows-native/src/Chat.cs` (cards), `Dialogs.cs`, web `Talk.tsx` |
| C | Owner default: connector availability for the owner is always allowed; the member ceiling stays. | `packages/connectors/src/*` capability policy, `connectorRoutes.ts` |
| D | Member requests: `request_connector_access` creates an approval the admin can decide from chat (card), the app (Approvals) or a phone notification; decision notifies the member's thread and continues the flow. | `settingsChangeTools.ts` (new area `member_connector_request`), approvals routes, notifications, mobile push |
| E | Prompt: Josi is told she is the way to configure Josi; never "check your Josi app". | `assistantAgent.ts` |
| F | Show the hidden pages again (Connectors, Apps, Storage) so what Josi talks about is visible. | `Flags.cs` (`Integrations = true`, committed in `28973e3`) |
| G | My World: Vault-backed personal records (people, places, documents, vehicles, properties, cards) with typed fields and per-field sensitivity; a page behind password or Hello; chat tools to add and update non-secret facts and to request a protected card for secret fields; Josi's memory references items by name, never by value. | `packages/core/src/vaultRecords.ts` (extend), new routes, `apps/windows-native/src` page and menu button, agent tools; World memory as its own table (`my_world_memory`) and its own loader into the turn context, outside `memoryEngine.ts`; the general engine never reads or writes it |

| H | Chrome extension, rebuilt to the same standard: attach a tab from chat ("use this tab"); reconnect survives the service worker's sleeps and a Josi restart (state persisted, alarms re-arm); Stop cancels any pending reconnect; store IDs wired through the native host's allowed origins; page operations cover frames, shadow DOM, selects, rich editors, scrolling and dragging, uploads and downloads, several tabs; permissions by one ask in chat (browser, profile, site, duration); clear connection states instead of "no connection"; browser work shows in the ghost bar and obeys Pause and Stop; password and payment fields are never read or filled; store-ready packages for Chrome, Edge and Firefox with consistent IDs and privacy copy. | `apps/browser-extension/src/*`, `scripts/unified/build-browser-extensions.mjs`, `apps/windows-native/src/BrowserHost.cs`, `BrowserBridge.cs`, `packages/agent/src/pcBrowserTools.ts` |

Verification is the same as PC control: a live chat on the installed build,
driven step by step, recorded in the acceptance doc. For the extension, a
real attached tab doing a bounded task (the garage-sale photo description
from the original handoff) is the acceptance.
