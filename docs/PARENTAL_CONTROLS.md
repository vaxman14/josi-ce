# Parental Controls

> **BETA — do not trust or rely on this feature for a child's safety.** It is
> experimental and may fail, be delayed or behave unexpectedly. It controls
> only Josi. It cannot control a device, other apps, websites, location or
> emergencies, and it does not replace active adult supervision or proven
> device-level parental controls. Verify important restrictions independently.

A paid module. It lets **one named adult** look after **one named child
account** on this installation: read their conversations with Josi, set the
hours Josi will answer, set a daily limit, turn topics off, answer the child
when they ask for more time, and see how much Josi is being used. One adult may
look after up to twelve accounts; each managed account has exactly one adult.

It is off on every installation until somebody activates a licence, and it
grants nothing to anybody except through an explicit relationship between two
accounts.

---

## What it is not

Read this part first, because the most damaging thing a control like this can do
is be believed.

* **It is not a device control.** Josi cannot lock a phone, close another app,
  filter the web, block a game, or see anything that happens outside Josi. If
  the limit that matters is the phone, the control that matters is on the phone.
* **It is not screen time.** A minute is counted when the child **sends
  something to Josi**. Time spent reading a reply is not counted, because this
  server cannot see a screen being looked at. "45 minutes a day" means 45
  minutes in which a message was sent, and every screen says so.
* **It is not administrator oversight.** The person who administers this
  installation activates the licence and gains nothing by it. They cannot see
  who is looking after whom, cannot read a child's conversations, cannot change
  anybody's hours, and there is no route that would let them.
* **This server enforces nothing on a device.** It cannot lock a phone or block
  an app, and no route here does. The one thing that touches a device is the
  list of blocked apps, and the server's whole part in that is to store the
  list and hand it to the child's own iPhone. Whether anything is then blocked
  is up to that phone, Apple's Family Controls, and the permission somebody
  gave it. See "Who enforces what" below.
* **A blocked topic is not a content filter.** It is an instruction to the
  assistant. Nothing reads Josi's reply afterwards to check it was followed,
  and a determined child may talk their way round it.
* **There are no spending limits.** Nothing on this server spends money on a
  child's behalf, so there is nothing a spending limit could honestly stop. It
  is not built and no screen or route offers it.
* **There is no second parent and there are no invitations.** One managed
  account has one adult. A second guardian, shared authority, or inviting
  another adult to a family is not built.

## Who enforces what

| Rule | Enforced by | How far to trust it |
| --- | --- | --- |
| Hours Josi answers | This server, at the start of every turn on every channel | As far as Josi goes. It says nothing about the device. |
| Daily limit, and extra minutes for today | This server, same place | Same. A minute is one in which a message was sent. |
| Blocked topics | The assistant, because it is told to | An instruction, not a filter. No reply is checked. |
| Blocked apps | **The child's iPhone**, with Apple's Family Controls | The server only stores and returns the list. If the phone is not set up, was not given permission, or is not an iPhone, nothing is blocked. The server cannot tell which. |
| Spending | Nobody | Not built. |

## The three things that grant anything

1. **A licence.** `module_entitlements` holds one row per paid module. Without
   it the routes answer 404, the schedule enforces nothing, and a managed child
   is an ordinary member.
2. **A relationship.** `parental_links` holds one live row per child. It is the
   only thing that grants a parent visibility, and it is checked at the moment
   of every read — ending it ends the visibility with nothing to delete.
3. **A password and a second factor, together.** Creating or ending a
   relationship is spent against a `parental_authority_grants` row, issued only
   for both proved in one request, bound to one session, good for five minutes,
   consumed once.

Nothing else grants anything. Role does not. Workspace membership does not.
Being the super admin does not.

## What each act costs

| Act | Cost |
| --- | --- |
| Read your own family's pages | a signed-in session |
| Change a daily limit, a timetable, the blocked topics or the blocked apps | the session, plus the password again (`change_settings` step-up) |
| Answer a child's request (approve or deny) | a signed-in session of the linked adult |
| Create a managed account, or end a relationship | the session, plus the password **and** a code from an authenticator, in one request |

The password-again on a limit change is not ceremony. The realistic attacker on
this feature is the child on the parent's unlocked laptop.

Answering a request does **not** ask for the password again, and that is a
choice with a cost. The same child on the same unlocked laptop could approve
their own request. What that buys them is bounded: extra minutes for **today
only**, at most 240 across the whole day, gone at their own midnight, and only
in answer to a request they filed from their own account. The standing limit,
the timetable, the topics and the apps cannot be changed that way, the answer
is written to the audit log, and it stays in the adult's request list for a
fortnight. A parent who wants to give more than the day's ceiling is told to
change the daily limit, which does cost the password.

## What the parent sees

* Every conversation the child has had with Josi, in full, including messages
  that arrived over Telegram or another connected channel.
* Minutes used today, and a summary of the last fortnight by day.
* Their timetable and their limit, and controls to change both.
* The topics turned off and the apps listed for the phone to block.
* What the child has asked for — more time, or access — with the note the child
  wrote, and the answer given.

Opening a conversation is written to the audit log **and shown to the child**.

## What the child sees

A page of their own that says, in plain words:

* who is looking after this account;
* exactly what that person can see — conversations, minutes, hours, last use;
* exactly what they cannot — the password, anything outside Josi, the ability to
  sign in as them;
* every time the adult looked, with what they looked at and when;
* what today's limit is, how much is left, and when Josi answers next.

The child is also told that topics can be turned off, that a list of apps can be
handed to their phone, and that their requests and the notes on them are seen by
the adult. The child's own phone can read the full list of blocked topics and
blocked apps through the rules route below: the lists are not secret from the
child's account. What Josi is told is narrower — in conversation it names only
the topic that was asked about.

Supervision somebody can see is a different thing from monitoring, and the
product takes the difference seriously enough to build the page.

## Child Mode

An account is in Child Mode exactly while a live `parental_links` row names it
and the module is entitled. In that state:

* Josi answers only inside the agreed hours and inside the daily limit, on
  **every** channel — the check is the first thing `runAssistantTurn` does, and
  every channel goes through that one function;
* the account cannot look after anybody, and cannot obtain an authority grant;
* the account cannot change its own hours or limit;
* everything else is unchanged. Their conversations are still theirs, their
  connections are still theirs, and nothing of theirs is transferred to the
  adult. Child Mode is a limit on time and a disclosure about visibility, not a
  demotion.

Ending a relationship removes the timetable, the limit **and the record of when
the account was being used** — that record was collected to enforce a rule that
no longer exists and to answer a question nobody may now ask. The blocked
topics, the blocked apps, any extra minutes and every request the child filed go
with it. The child's conversations are their own and are never touched.

If the licence lapses or is revoked, the module goes inert **in both
directions**: the parent stops being able to see anything, and the child stops
being held to a timetable that nobody with authority can see or change.

## Blocked topics and blocked apps

Both are set by the adult through the same controls route as the hours and the
limit, with the same password step-up, and both are recorded in the audit log by
field name only.

* **Blocked topics** — up to 20, each 1 to 60 characters of plain text. On the
  child's own turn, and nobody else's, the assistant's instructions say that a
  parent has turned these topics off, that it does not discuss them, that it
  says so plainly when asked, and that it does not list the other topics. That
  is the entire mechanism. It is a model instruction: it is not a filter on
  what Josi says, it is not checked afterwards, and it covers Josi only.
* **Blocked apps** — up to 100 app bundle identifiers such as
  `com.example.game`, checked for shape and nothing else. **The server stores
  and returns them and does nothing more.** The child's iPhone reads the list
  and applies it with Apple's Family Controls, if the phone was set up to and
  given permission. Nothing comes back to the server to say it worked.

## The rules the child's phone reads

`GET /api/parental/rules`, with the child's own session, returns one versioned
object: who the guardian is, the timezone, the daily limit, minutes used and
extra minutes today, the timetable, the blocked topics and apps, and whether
Josi is answering right now. It is built from the same functions the turn uses,
so the phone and the server cannot disagree. An account that is not a managed
child gets `{"version": 1, "managed": false}` and nothing else. Like every
route here it is 404 without the licence.

## Asking for more time, or for access

A managed child can ask (`POST /api/parental/requests`): for more time today,
optionally saying how many minutes (5 to 240), or for access to something, with
a note of up to 300 characters. Asking changes nothing.

* One open request per child per kind, and six requests an hour.
* More time can only be asked for when a daily limit is set. Without one there
  is nothing for extra minutes to add to, and the route says so.
* Only the linked adult can answer (`POST /api/parental/requests/:id/decide`).
  Everybody else — another parent, the super admin, the child — gets 404, the
  same answer as for a request that does not exist.
* **Approving more time** adds minutes to the child's current local day and no
  other: the amount asked for, or a different amount the adult chooses, or 15
  if neither said. At most 240 extra minutes in one day, across all approvals.
* **Extra minutes extend the daily limit. They do not open a closed
  timetable.** Outside the agreed hours Josi still does not answer, however
  many extra minutes there are.
* **Approving access unlocks nothing on the server.** There is nothing here to
  unlock. The answer is recorded and the child's phone is told; what the phone
  does with it is the phone's business.
* When a child asks, a notification is queued for the adult's phones; when the
  adult answers, one is queued for the child's. The text is the child's name
  and the kind of request — never the note. A phone can switch the `family`
  notification category off.

## The whole iPhone

Added in 1.2.8-beta.17, for the Josi iPhone app.

**This server enforces none of it.** The rules are stored and returned. The
child's iPhone applies them with Apple's Screen Time, and only if the Josi app
on that phone has been set up to and allowed to.

- `device` object, same snake_case keys everywhere: `daily_limit_minutes`,
  `bedtime {start_minute, end_minute}` (may run past midnight), `web_filter`,
  `max_app_rating` (4, 9, 12, 17 or null), `block_app_installs`, and the
  read-only `setup_open_until`.
- It is in `GET /api/parental/rules` and `GET /api/parental/children/:id/controls`,
  and `PUT /api/parental/children/:id/controls` accepts it. Changing it costs
  the password again, like every standing rule. Only the keys sent change.
- Extra minutes a parent approves count for the iPhone limit too: the phone
  reads the same `extra_minutes_today`. A child may ask for more time when
  either limit (Josi or iPhone) is set.
- `POST /api/parental/children/:id/device-setup` (linked parent, a session):
  opens ten minutes in which the child's phone lets the counted apps be
  changed. It changes no standing rule, is written to the trail
  (`parental.device_setup_opened`), is shown on the child's Family page, and
  the child's phone gets a `family` push.
- `POST /api/parental/device-events` (the managed child only):
  `{events: [{kind, minutes?, at}]}`, kinds `phone_minutes`, `limit_reached`,
  `bedtime_started`, `bedtime_ended`, `asked_more_time`. A repeat of the same
  `(kind, minutes, at)` is skipped. Events older than 7 days or in the future
  are dropped. The parent gets one `family` push when a limit is reached.
- `GET /api/parental/children/:id/device-activity` (linked parent):
  `{timezone, today: {phone_minutes}, events}`, today and yesterday in the
  child's own days, newest first. Looking is written to the trail
  (`parental.device_activity_viewed`).

What the phone reports is the phone's word: totals and moments, never an app
or a website (Apple does not let those leave the phone). A phone that is off
or signed out reports nothing. When the relationship ends, the reports are
deleted with the rest.

## Answering by asking Josi

A parent with at least one child is offered one tool in conversation,
`family_requests`: list what is open, approve or deny one. It calls
`decideFamilyRequest`, the same function the button uses, so the relationship
is the only authority, the 240-minute day ceiling holds, and the answer is in
the trail. It cannot change a limit, a bedtime or any other standing rule, and
it cannot add time without a request the child filed.

## Accounts

A parent creates a managed account from their Family page; it is a new account
on this installation, always an ordinary `member`, linked to them, with a
one-time set-up link to open on the child's device.

**There is deliberately no route that links an account that already exists.**
"Make this account my managed child" applied to somebody who already has one is
surveillance with a friendly name, and the person on the other end of it would
never be asked. One adult may look after twelve accounts at most — a blast
radius, not a licensing limit.

## What is recorded

In the ordinary audit log, as metadata and never as content:

`entitlement.activated`, `entitlement.revoked`, `entitlement.refused`,
`parental.authority_granted`, `parental.authority_failed`,
`parental.link_created`, `parental.link_ended`, `parental.controls_updated`,
`parental.conversations_listed`, `parental.conversation_read`,
`parental.usage_viewed`, `parental.request_filed`, `parental.request_decided`.

Payloads carry ids, counts, factor names and the *names* of fields that
changed — never their values, never a licence token, never a word of a
conversation. A schedule is a fact about a household, so even the hours stay out
of the trail the installation's administrator reads. The same goes for the
blocked topics, the blocked apps, the minutes asked for or given, and the note
on a request: the trail says that something was asked and how it was answered.

## The licence

**Included for now (owner's decision, 2026-11-10).** Parental controls are on for every
installation without a licence: `entitlementStatus` answers `included` for the modules listed in
`includedModules` in `packages/core/src/entitlements.ts`. They may become a paid module again;
that is removing `parental_controls` from that list, after which everything below applies as
written and an installation without a live licence goes inert. Wherever this document says the
module is "off until a licence is activated", read it as describing that paid state.

The supported Admin licence page accepts the installation licence format
`<payload>.<signature>`: a JSON payload naming the covered features, buyer,
optional installation id and optional expiry, with an Ed25519 signature over
the payload bytes. Existing module-specific `josi-lic.1.<payload>.<signature>`
licences remain accepted for backward compatibility. Both formats are verified
against the same publisher key stamped into the build
(`BUILD_LICENCE_PUBLIC_KEY`, written by `scripts/stamp-edition.mjs`, absent by
default).

A build with no stamped key verifies nothing and refuses every licence, which is
the truthful state for an artefact the publisher did not build. The admin page
says exactly that rather than letting somebody paste a key that will never work.

A licence that names an installation is re-checked against
`install_identity.install_id` on every read, so a database restored onto another
machine keeps the row and loses the entitlement.

## Where the code is

| Piece | File |
| --- | --- |
| Schema | `packages/db/migrations/0039_parental_controls.sql`, `0130_family_requests_and_rules.sql` |
| Licences | `packages/core/src/entitlements.ts` |
| Authority, timetable, minutes, topics, requests | `packages/core/src/parental.ts` |
| Routes (member and admin) | `apps/api/src/http/parentalRoutes.ts` |
| Enforcement on every channel | `packages/agent/src/assistantAgent.ts` |
| Family page | `apps/web/src/pages/Family.tsx` |
| Licence page | `apps/web/src/pages/admin/ParentalControls.tsx` |

Tests: `apps/api/test/parentalControls.test.ts` (over the wire),
`packages/core/test/parental.test.ts` (licences, timetable, decision),
`packages/agent/test/parentalTurn.test.ts` (every channel).
