# Server answers to "What the iPhone app needs from the server"

Written 2026-11-10 by the server session, for the iPhone builder. Built on branch
`linux/josi-server`, shipped as Linux **1.2.8-beta.16**. Numbers follow the iPhone note.
All routes are under `/api`, need the usual session, and answer errors as `{error}`.

## 1. Push straight to Apple: built

Nothing changes on the phone. `PUT /api/assistant/devices` takes what build 31 already sends:

- `apns_token` (hex, any case), `apns_environment` (`"sandbox"` or anything else = production),
  `apns_topic` (defaults to `com.socalreceptionist.josice` when missing).
- `categories` may now also carry `family` (see item 7). Unknown categories default to on.

What Apple receives:

```json
{ "aps": { "alert": { "title": "Josi", "body": "…" }, "sound": "default", "thread-id": "<thread id, or the route name>" },
  "data": { "route": "turn", "id": "<id>", "threadId": "<thread id, when there is one>" } }
```

- `data.route` is one of `turn`, `approval`, `task`, `calendar`, `reminder`, `family`. These are the
  same events Android gets. A reminder also carries `owner` and `revision`, as before.
- Headers: `apns-push-type: alert`, priority 10, expires after a day.
- No `badge` is sent: the server does not keep an unread count.
- On 410, `Unregistered` or `BadDeviceToken` the device is removed; register again on next launch.
- Until the owner saves the Apple push key (Admin, Overview, "iPhone notifications") a push retries
  for a few minutes and is then dropped. The reply itself is never lost; only the notification is.

## 2. Microsoft sign-in: built, as agreed

`GET /api/auth/native/config` returns `microsoftSignIn` (true only when Microsoft is set up) and
`nativeMicrosoftStart` (always present; use it only when the flag is true). Start and exchange are
at `/api/auth/microsoft/native/start` and `/api/auth/microsoft/native/exchange`, same shapes as Google.

## 3. Sign in with Apple: on by default

Every server now uses `com.socalreceptionist.josice` unless its owner sets
`APPLE_NATIVE_CLIENT_ID` (another id, or `off`). `appleSignIn` in the native config is true.
Revoking Apple sign-in when an account is deleted is not built (needed for the App Store, not TestFlight).

## 4. Short spoken replies: built

`POST /api/assistant/threads/:id/turns` takes two new optional fields:

- `reply_style: "spoken_short"`: Josi answers in one or two plain spoken sentences.
- `wait_seconds`: how long the request may stay open, 0 to 20. Default 8 when `reply_style` is set.

The answer is the usual `202 {turn, …}` plus:

```json
"spoken": { "text": "Two things: call Alex, and the dentist at three.", "final": true, "message_id": "…" }
```

- `final: true`: say `text`. The reply was ready in time. No notification follows for it.
- `final: false`: say `text` (it is "I'm on it. I'll send the answer to your phone."). The full
  reply arrives as a normal push with `data.route = "turn"`.
- `final: true, failed: true`: the turn failed; `text` says so.
- Any other `reply_style` value is a 400. Without `reply_style` nothing changes.

## 5. Reminders: two-way sync built

Routes answer at both `/api/reminders` and `/api/assistant/reminders`.

- `POST /api/reminders` `{title, notes?, due_at, timezone, source: "ios", external_id}` →
  `201 {reminder, created: true}` or `200 {reminder, created: false}` when that `external_id` exists.
- `POST /api/reminders/:id/complete` → `200 {reminder}`. Safe to repeat.
- `GET /api/reminders` → `{upcoming: [...], recent: [...]}`.
- A reminder is `{id, body, notes, due_at, timezone, revision, status, delivered_at, completed_at,
  source, external_id, thread_id, created_at, updated_at}`. **The title comes back as `body`.**
  `status` is `scheduled | delivered | cancelled | failed | completed`. Tick it off in Apple
  Reminders on `completed` or `cancelled` only; `delivered` just means Josi sent the alert.

Things to handle on the phone:

- A `due_at` in the past (or more than 366 days ahead) is a 400. Skip overdue Apple reminders.
- A reminder made on the phone also gets Josi's own push when due. Do not schedule a second alert for it.
- `recent` covers 7 days, 100 items. Sync at least weekly.
- There is no un-complete and no delete. Cancelling is `POST /api/assistant/reminders/:id/cancel`.

## 6. Store keys: built

`GET /api/connections/developer` now returns `fields: [{key, label, secret, multiline, help}]` for
every service. Build every form from it. Two new services:

- `appstoreconnect`: `issuerId`, `keyId`, `privateKey` (secret, multiline).
- `googleplay`: `serviceAccountJson` (secret, multiline), `packageName`.

`PUT /api/connections/developer/:service` takes the field keys at the top level, for example
`{"issuerId": "…", "keyId": "…", "privateKey": "-----BEGIN PRIVATE KEY-----…"}`. Old bodies still work.
The key is checked with Apple or Google first; a refused key is a 400 with a plain reason and nothing is saved.
Success is `{ok: true, accountLabel}`. Only App Store Connect team keys work (they have an Issuer ID).
Both services start switched off for members until the owner allows them, like the other services.
Josi's own In-App Purchase key and App Store Server Notifications are not built.

## 7. Parental controls: the server part is built, inside the existing paid module

Every route is a 404 until the server's owner activates the parental controls licence.

- `GET /api/parental/rules` (the child's own phone):
  `{version: 1, managed: true, guardian: {name}, timezone, daily_limit_minutes, minutes_used_today,
  extra_minutes_today, schedule_enabled, windows: [{weekday, start_minute, end_minute}],
  blocked_topics: [], blocked_apps: [], access: {allowed, reason, opens_again}, updated_at}`,
  or `{version: 1, managed: false}`.
- `blocked_apps` are bundle ids. The server only stores them; the phone enforces them with Family Controls.
- `blocked_topics` are enforced by Josi in conversation (an instruction to the model, not a filter).
- `POST /api/parental/requests` (child) `{kind: "more_time" | "access", minutes?: 5..240, note?}` →
  `201 {request}`. 409 when one of that kind is already open.
- `GET /api/parental/requests` → `{role: "child" | "parent" | "none", requests: [...]}`.
- `POST /api/parental/requests/:id/decide` (parent) `{decision: "approve" | "deny", minutes?}` →
  `200 {request, extraMinutesToday, maxExtraMinutesPerDay: 240}`.
- Request objects are camelCase: `{id, kind, status, minutes, note, minutesGranted, createdAt, decidedAt}`.
- Push: the parent gets `data.route = "family"`, `data.id = <request id>` when a child asks; the child
  gets the same when the parent answers.
- Extra minutes extend today's limit only. They do not open a closed timetable window.

Not built: family groups with a second parent, invites, spending limits. Today one parent creates
each child account (up to 12); a child has one parent.

## 8. Parental controls round 2: built in Linux 1.2.8-beta.17

Answers to section 8 of the iPhone note. Still 404 until the licence is active.

### 8a. The `device` object: built

Exactly the keys asked for, snake_case, on all three routes:

```json
"device": { "daily_limit_minutes": 120, "bedtime": {"start_minute": 1260, "end_minute": 420},
            "web_filter": true, "max_app_rating": 12, "block_app_installs": false, "setup_open_until": null }
```

- `GET /api/parental/rules` carries it inside the rules object. It is always present for a managed
  child; with nothing set it is all `null` / `false`.
- `GET /api/parental/children/:id/controls` answers `{controls, device, honesty}`: `device` sits
  **beside** `controls`, not inside it.
- `PUT /api/parental/children/:id/controls` takes `{"device": {...}}` and answers `{controls, device}`.
  Same password re-check (401 until `POST /api/assistant/step-up`). Only the keys you send change;
  `setup_open_until` in the body is ignored. A bad value is a 400 with a plain reason.
- `daily_limit_minutes` is 5 to 1440 or null. `bedtime` minutes are 0 to 1439 and must differ.
- `setup_open_until` is an ISO time only while the window is open, otherwise null.
- More time: nothing new. The phone adds `extra_minutes_today` to the iPhone limit itself. A child
  can now ask for more time when only the iPhone limit is set (it used to need a Josi limit).

### 8b. Setup window: built

`POST /api/parental/children/:id/device-setup` (the linked parent, a session, no password) →
`200 {"open_until": "<iso>"}`, ten minutes from now. Calling it again restarts the ten minutes.
The child's phone gets a `family` push with `data.id` = **the child's own user id** (there is no
request). It is in the trail and on the child's web Family page.

### 8c. Activity: built

- `POST /api/parental/device-events` (child only; 404 for anybody else), up to 100 events →
  `200 {"ok": true, "accepted": 2, "duplicates": 1}`. Unknown `kind`, a `phone_minutes` without
  `minutes`, or a missing `at` is a 400 for the whole post. Events older than 7 days or more than
  10 minutes in the future are dropped silently. More than 120 posts an hour is a 429.
- `GET /api/parental/children/:id/device-activity` (parent) →
  `{"timezone": "…", "today": {"phone_minutes": 60}, "events": [{"kind", "minutes", "at"}], "honesty": {…}}`.
  Newest first, today and yesterday in the child's timezone. `today.phone_minutes` is the largest
  `phone_minutes` total reported today.
- On `limit_reached` the parent gets one `family` push; `data.id` is the child's user id. It is sent
  again the same day only if extra time was given in between.

### 8d. Turned on

The web Family page and the Admin "Parental controls" page are now shown. How a customer gets the
licence is still the owner's decision.

### 8e. Asking Josi: built

The parent's assistant has a `family_requests` tool (list, approve, deny). Nothing to do on the phone.

### Family push ids, all three cases

`data.route = "family"` and `data.id` is: the request id (a child asked, or a parent answered), or
the child's user id (setup window opened, iPhone limit reached). Refresh rules and requests on any of them.

## 9. Several accounts per service, Stripe, and Google Play by account: built in 1.2.8-beta.17

Changes to item 6. Old calls still work; a phone that ignores all of this keeps working with the first account.

- `GET /api/connections/developer`: every service now also has
  `accounts: [{account, name, accountLabel, status, lastCheckAt, lastCheckOk, lastError, lastUsedAt}]`
  and `maxAccounts` (25). `connection` is still there and is the first account.
  `account` is the key to send back; `name` is the person's own name for it (may be null);
  `accountLabel` is what the service called it.
- **Add another account:** `POST /api/connections/developer/:service/accounts` with the field keys
  and an optional `name` → `201 {ok, account, accountLabel, created: true, detail}`. With no account
  yet it becomes the first one. Pasting an account that is already connected replaces its key
  (`200`, `created: false`). Show an "Add another account" button under the list.
- Replace one account's key: `PUT /api/connections/developer/:service/accounts/:account`.
- Rename: `PATCH /api/connections/developer/:service/accounts/:account` `{name}`.
- Check one: `POST /api/connections/developer/:service/accounts/:account/check`.
- Remove one: `DELETE /api/connections/developer/:service/accounts/:account` → 204.
- The old `PUT /:service` writes the first account. The old `POST /:service/check` is a 409 when
  several accounts are connected (it cannot guess which). The old `DELETE /:service` removes
  **every** account of that service.
- A field may now carry `optional: true`. Do not require it.
- `googleplay`: the key is the account's. `packageName` is now optional and may list several
  package names separated by commas. Label is now "Package names (optional)".
- New service `stripe` (one field, `token`: a restricted API key). Off for members until the owner allows it.
- Supabase accounts are now named by their organization, not by a project count.
