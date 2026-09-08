# Authorising a write — calendar, mail and contacts

Round-3 item 26. Asking Josi in chat to create a calendar event used to cross
three separate gates that did not know about each other: the tool parked a task
at "awaiting approval" but wrote no approval record, so the Approvals page was
empty; the Tasks page then demanded the account password to move the task to
"ready"; and carrying it out was left to a worker tick that could silently do
nothing. The end state read "Ready to go" and no event ever existed.

There is now one question and one place to answer it.

## The question

When a draft tool (`draft_calendar_event`, `draft_email`, `draft_contact_update`)
prepares work, Josi asks the owner's **effective approval level** for that class
of action — the stricter of the person's own setting and the administrator
ceiling — whether this specific action needs their agreement.

| Effective level | Ordinary self-only action | Action involving other people |
|---|---|---|
| `always_ask` | one approval card | one approval card |
| `risky_only` | carried out immediately | one approval card |
| `automatic` | carried out immediately | one approval card |

"Involving other people" is read from the task's own slots — a calendar event
with attendees, an email with a recipient — never from anything the model said.
It maps to `invite_external`, which is always risky and is therefore never
automatic at any level.

`risky_only` previously behaved identically to `always_ask`, which made the
Settings label "Ask only for risky or destructive actions" untrue. It now means
what it says. The relaxation is narrow: a fresh installation's administrator
ceiling is `always_ask` for every class, and loosening one is a separately
confirmed act that is recorded as `approval.ceiling_relaxed`.

## Where the person answers it

One approval, shown in two places that are the same record: a card in the
conversation the request came from, and the Approvals page. **Approve carries
the write out in that same request** and the answer reports what the provider
said. `carriedOut` is true only when the provider accepted it; otherwise the
real failure is shown. Nothing else is asked afterwards.

The Tasks page is a record, not a gate. It shows state and, on a failure, the
reason — it no longer offers a way to approve anything.

## Step-up re-authentication

Confirming the account password is reserved for the genuinely consequential:
a high-impact action class, or a write that puts something in front of somebody
who is not the owner. Sending mail keeps its gate because an email always has a
recipient; a calendar event with attendees keeps it. Booking half an hour in
your own diary, which you just asked for out loud, does not. A gate met
constantly is a gate people learn to clear without reading.

## States

`ready` means queued, not done, and is displayed as **Queued to run**. A task
that nothing can carry out — because the write capability is switched off —
fails with a reason naming the switch, rather than resting at `ready` forever
looking like the last step before success. `failed → ready` remains a legal
transition, so turning the capability on and retrying works.

Only `confirmed` means the provider accepted the write.
