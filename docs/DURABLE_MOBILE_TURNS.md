# Durable native turns and Expo push

Migration `0057_durable_mobile_turns_push.sql` reserves `0056` for the parallel assistant migration.

## Native API contract

All routes use the existing authenticated session and CSRF boundary. Resources are owner-only; a thread share and super-admin role do not grant access.

### `POST /api/assistant/threads/:threadId/turns`

Accepts JSON:

```json
{
  "client_message_id": "stable-device-generated-key",
  "message": "hello",
  "reply_to_message_id": "optional-message-uuid",
  "attachment_receipts": ["already-uploaded-attachment-uuid"],
  "attempt_of": "optional-failed-turn-uuid"
}
```

`Idempotency-Key` may supply `client_message_id`. The server atomically verifies owner/thread bindings, pins ready upload receipts, persists the inbound message and durable turn, and enqueues one opaque `assistant.turn` job. It returns `202` immediately:

```json
{"turn":{"id":"uuid","job_id":"uuid","status":"queued","lifecycle_state":"accepted_queued","thread_id":"uuid","client_message_id":"...","attempt_of":null},"duplicate":false,"telemetry":{"state":"accepted_queued","turn_id":"uuid","thread_id":"uuid"}}
```

Reusing the key with the exact request returns the same turn with `duplicate: true`; reusing it for different input returns `409 idempotency_conflict`. Submission is limited to 20 turns per owner per minute and 50 queued/running turns per owner; overload returns `429` with `Retry-After`. A terminal failure remains `failed`. Retry by sending a new `client_message_id` and linking `attempt_of` to that failed turn.

### `GET /api/assistant/threads/:threadId/turns?after=<RFC3339>`

Returns owner-scoped queued/running/completed/failed reconciliation state. `completed` is emitted only after the assistant message is persisted. Failure includes a stable code and `retryable` hint.

`job_id` intentionally equals the opaque turn UUID; the database queue's
sequential internal identifier is never exposed. Native records a Sentry
breadcrumb/tag only from the content-free `telemetry` shape. Before receiving
the `202`, transport exceptions are tagged `pre_accept_transport_failure` and
the same idempotency key is safe to retry. After receiving `202`, the client
must not report a generic network failure if it is killed or loses transport:
it stores the opaque IDs and reconciles, tagging `accepted_queued`,
`reconciling`, `completed`, or `terminal_failed`. Never attach message text,
attachment names/content, auth data, or push tokens to those events. This is
the regression contract for production Sentry event
`64dfcff0fc1c4b9aae0d528530bf9548` (`josi-mobile`, iPhone18,2,
2026-09-18 01:55:22 PDT).

### Device registry

- `PUT /api/assistant/devices` registers or rotates `device_identity`, `platform`, `expo_token`, `app_state`, `privacy_locked`, category booleans, quiet-hour local times, and IANA `timezone`.
- `GET /api/assistant/devices` returns settings and state, never a token or ciphertext.
- `DELETE /api/assistant/devices/:deviceId` revokes the owner-bound device.

Expo tokens are AES-256-GCM sealed with the installation master key. Logs, events, queue payloads, API responses, and audit data never contain plaintext tokens. Registering a token after an account switch revokes its old owner binding.

## Worker and delivery semantics

Each accepted turn records the authenticated server-side session. A queued turn fails closed as non-retryable `session_expired` if that login is revoked or expired, or the account is disabled, before the worker starts it. Workers renew live execution leases so slow provider responses are not mistaken for crashed work. They reclaim expired queue rows after crashes, but do **not** replay an
expired running model/tool turn: its state becomes retryable
`worker_interrupted`. A compare-and-set lease prevents the old process from
later creating a reply. The client may submit a new idempotency key linked by
`attempt_of`. This is deliberate: CE cannot prove whether a provider accepted
the last request before the process died, so automatic replay would violate the
no-duplicate-action boundary. Existing action-state, approval hash/consumption,
and task compare-and-set boundaries additionally protect consequential tools;
persisted action results become turn tool receipts.

Assistant completion and approval-needed notifications, plus explicit reminder notifications, create unique per-device outbox rows only after their source state is persisted. Foreground devices suppress banners. Privacy lock replaces content with generic text. Ordinary updates respect local quiet hours using `Intl` IANA timezone conversion (including DST); explicit reminders may bypass quiet hours. Deep-link data contains only a route type (`turn` or `reminder`) and its opaque, owner-authorized UUID; provider event identifiers and content never enter it.

The Expo sender uses batches of at most 100, unique `(device,event)` delivery keys, bounded exponential retry, and separate ticket/receipt states. A ticket is not delivery. Only a successful receipt becomes `delivered`; `DeviceNotRegistered` revokes the device. Deep links contain only route type plus opaque UUID.

Tests inject HTTP and never contact Expo. No EAS cloud build is involved.

## Known provider boundary

Expo does not provide an idempotency key for push requests. If a worker loses the HTTP response after Expo accepted a request, retry can produce a duplicate OS notification. The database guarantees one logical delivery/outbox row and never falsely marks it delivered, but transport-level exactly-once is not claimable. Model providers likewise do not universally provide crash-safe idempotency; this is why an interrupted turn fails closed rather than automatically replaying, while server-side consequential actions remain fenced by CE's persisted approval/action/task state.
