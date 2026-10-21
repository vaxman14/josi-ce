# Josi native.17: ChatGPT photos and visible failed requests

This update adds ChatGPT-subscription browser photo descriptions through the Vault-managed official Codex CLI. The model proposes one structured action at a time; Josi validates its name and arguments and executes it through the existing native automation permissions. No API key is required.

Chat requests now appear in Task Manager independently of whether the model created a goal. Failed requests appear under Needs You / Waiting and History, with a link from Active. Chat also displays a failed-run notice instead of leaving an unanswered message. The model card labels its saved capability check accurately; that check is not proof of a currently signed-in subscription.

The existing layout remains in place apart from these status and task-history additions.

## Setup and first live check

Install the signed native.17 package over the existing application, then reopen Josi. Use the existing ChatGPT subscription in Models. Its primary model must have an explicit name and passing chat, tool-calling and vision checks. If needed, reconnect using Change → Check Status.

The separate Chrome desktop must be connected and authorized. In Automation, register the current named ChatGPT model as a destination, then permit model transmission to that exact configuration. Existing site observation/fill/navigation/network permissions and task limits still apply. Changing a model configuration requires registering its current destination. This update does not grant those permissions automatically.

Start with this prompt:

> Open https://romansgaragesale.com/uploads in the separate desktop’s Chrome. Find the first photo with an empty description. Examine the photo and readable text, then fill an accurate garage-sale description. Describe only what is visible, preserve existing descriptions, and do not submit or publish. Stop after the first photo so I can review it.

Inspect the filled field and Task Manager before continuing the remaining empty descriptions. The site’s existing browser autosave behavior still applies.

## Verification and limits

- TypeScript build and Swift 6 typechecking passed.
- 61 focused automated test cases passed, covering structured proposals, real image-byte delivery to the adapter, permission refusal, model changes, local-only mode, duplicate/missing dispatch, existing subscription tool execution, registry behavior and owner-scoped failed-run history. The broad repository credential-string scan was excluded from this focused run.
- The real bundled Codex 0.152.0 CLI sent a valid image content block plus the strict response schema to a localhost fixture and parsed its response. This verifies protocol compatibility, not real model inference.
- A real supervisor process with an inert CLI verified private image/schema permissions, dispatch refusal before launch, process closure and temporary-file cleanup. No real login was used by these checks.
- Installer build verifies Socal signatures, extracted app signatures and payload integrity.
- No descriptions were written to the live site during development. Live signed-in photo inference, actual browser filling, and the updated native UI remain acceptance checks after installing the update.
- This is a local signed test candidate, not a notarized release.

The capture path permits one supervised inference invocation and no Josi fallback or session reuse. The official CLI controls its own internal transport retries. Images and schemas are short-lived supervisor-owned files; saved task receipts retain opaque operation references rather than captured image bytes.

