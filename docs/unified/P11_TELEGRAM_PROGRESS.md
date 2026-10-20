# P11 Telegram work summaries

Implementation checkpoint under the owner's build-first direction. This extends Josi's existing Telegram channel; it introduces no OpenClaw or Hermes connection.

Telegram now saves the real inbound request before running the model and passes that message ID to the shared goal/tool engine. Successful, refused and failed turns retain one original inbound message. Recent conversation history excludes that current request, avoiding a duplicate model input. The server records the original authenticated link and bot identity as message metadata, rather than accepting a model-selected destination.

Migration 0086 adds a provider receipt projection and a ten-second worker schedule. For work originating in that private Telegram chat, the worker creates one plain-text checklist message and edits it as the saved goal changes. The summary contains verified counts, bounded step titles, state, current activity and a precise question or scheduled check. Longer plans visibly point to Tasks for full detail. Checkpoint facts, tool receipts, screenshots, unrelated conversations and Vault data are not sent.

The worker coalesces changes, processes a bounded batch, serializes claims, throttles per original link and skips unchanged summary content. It rechecks the active account, original link/chat/thread, bot identity and current Vault-issued token before transmission. Web/native work is not automatically broadcast to Telegram, and reconnecting another chat cannot redirect old work. Closing the original thread or revoking its link stops future updates; a request already dispatched cannot be recalled.

First sends have no assumed provider idempotency. A timeout, lost receipt, interrupted worker or unusable response leaves delivery uncertain instead of silently creating duplicate messages. A known provider rate-limit refusal can schedule a later attempt. The original task remains authoritative and continues independently of channel delivery. The Tasks page separately shows current, pending, failed, uncertain or disconnected channel progress.

The adapter uses the official [sendMessage](https://core.telegram.org/bots/api#sendmessage) and [editMessageText](https://core.telegram.org/bots/api#editmessagetext) methods, omits rich-text parsing and disables link previews. This is a persisted checklist projection, not an ephemeral typing draft.

## Remaining work

Real bot acceptance, first-send crash/reconciliation, concurrent link changes, rate limits and deleted/expired provider messages remain for the integrated testing pass. Manual recovery of an uncertain channel receipt, push-style alerts for every blocked/completed goal, automatic relay of full background replies, other external channels and mobile live-view controls remain open. Editing a checklist is not a guarantee that Telegram raises a new notification.

Automatic model continuation still requires the existing live CE owner session; an active Telegram link alone does not manufacture a server session or step-up approval. No live bot message, model request, migration or channel configuration change was made while building this checkpoint.

Build checks passed: root TypeScript compilation, web type checking, the web production bundle, the public-source secret scan (1,169 files) and whitespace checks. Functional suites remain deferred.
