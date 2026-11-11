# Josi's built-in debugger: plan (step one of a self-healing doctor)

Asked for by Roman on 2026-11-10, after an afternoon of finding problems on gate by hand.
This is a plan. Nothing here is built.

## What Roman asked for

- A debugger built into Josi, hidden before release.
- He asks her; she works out what went wrong and tries to fix it.
- If the fix touches code in a sensitive way, she asks him first.
- She gives him everything he needs to know.
- He can tell her to switch to a better coding model, or to write a handoff for Claude.
- This is step one. The destination is a doctor that heals Josi by itself.

## The one-paragraph version

When the owner says "what went wrong there?" or "debug this", Josi collects a case file
from her own records (the conversation, what her tools returned, approvals, tasks, the
goal, the audit trail, the service logs), reads it, and answers in plain words: what
happened, why, what she can put right now, and what needs him. Problems in her state
(something stuck, expired or half-done) she repairs from a fixed list of safe repairs.
Problems in settings go through the cards she already has. Problems in her program she
never edits in place: she explains them, and offers to think harder with a stronger
model or to write a handoff for Claude with the evidence attached.

## Why it is shaped this way

Three facts about Josi as built decide most of this.

1. **She already keeps the evidence.** Every turn, tool result, approval, task, goal step
   and audit event is in her database, and the services log to the system journal. Today
   I answered "why is there no card?" from five status columns. She can do the same; she
   just has no tool that gathers them.
2. **She already has a Doctor.** System checkup (`doctorRoutes.ts`, `nativeLinuxDoctor.ts`)
   checks the machine, makes a plan and runs safe repairs. It knows about services, disk
   and updates. It knows nothing about conversations, approvals or goals. The debugger is
   the same idea pointed at her behaviour, and should live beside it, not replace it.
3. **Her installed program must not be edited.** The installed files are compiled and
   checked against an inventory, and updates replace them whole. A hot fix would break the
   check and vanish at the next update. So "fix the code" on a running Josi always means
   "produce a change for the next build", never "change what is running".

## What the owner sees

He types, or says, something like *"why didn't the card show up?"*, *"debug that"*,
*"what happened with the email to Roman?"*. Josi answers in the chat with one report:

- **What happened.** A short timeline in plain words with times in his timezone.
- **Why.** The cause, and how sure she is.
- **What I can do now.** The repair she proposes, what it changes, and that it can be undone.
- **What needs you.** A decision, an approval, or a setting.
- **What needs a code change.** Said plainly when the cause is a defect in her program,
  with the two offers: think again with a stronger model, or write the handoff.

A "Details" fold under the report holds the evidence (the rows and log lines she used),
for when he wants to check her.

Worked example, from today on gate:

> **What happened.** At 3:34 PM I prepared the email and showed you a card. The request
> expired at 3:49 PM. At 4:30 PM you said "send it now". I told you to use the card above.
> There was no card.
> **Why.** Requests last fifteen minutes. I did not recognise "send it now" as an answer to
> an expired request, and I answered from memory instead of checking. (Sure.)
> **What I can do now.** Prepare the same email again so you get a working card. Nothing
> is sent until you approve it.
> **What needs a code change.** I should recognise that phrase and never point at a card I
> have not just made. I can write that up for Claude, or look deeper with a coding model.

## How it works

### 1. Collect: the case file

One tool, `debug_collect`, owner only. It takes the conversation and a time window and
returns a fixed, redacted bundle. The model does not write its own database queries.

| Part | From | What is kept |
|---|---|---|
| Conversation | `messages` | Direction, time, text (trimmed), which message showed which request |
| Turns | `assistant_turns` | Status, error code, which tools ran and what state each returned |
| Requests | `assistant_action_states`, `approvals` | Status, created, expired, decided, shown-in message |
| Tasks | `tasks` | Kind, state, failure reason, next wake |
| Goals | `work_goals`, `work_goal_events` | State, steps, checkpoint, the open question, next run |
| Audit trail | `events` | Kinds and times around the window |
| Jobs | `job_queue` | Failed or overdue jobs |
| Services | Doctor's checks, journal | Health now; warnings and errors in the window |
| Build | build stamp | Version, commit, platform |
| Accounts | `connections` | Provider, health, which permissions are on |

Never in the bundle: secrets, tokens, Vault contents, other people's conversations, full
email bodies (first lines only), anything the owner's own role could not already see.

### 2. Diagnose: one of five causes

She reads the case file and names the cause as exactly one of:

| Cause | Example from today | What follows |
|---|---|---|
| **Stuck or expired state** | Approval expired; goal still asking about it | A repair |
| **A setting** | Sending account not chosen; a permission switched off | A settings card |
| **Outside Josi** | Google refused the send; no internet | Say so, say what to do |
| **Her own answer** | She pointed at a card that did not exist | Correct it now; note it |
| **A defect in her program** | "send it now" not understood; goal never told its email was sent | Ask the owner (section 4) |

Each finding carries its evidence and a confidence. "I can't tell" is an allowed answer,
with what she would need to tell.

### 3. Repair: a fixed list, not free rein

Repairs are named functions with tests, each with a preview ("this will…") and an undo
where one exists. She may only choose from the list.

First list, all from problems seen today:

- Prepare an expired request again (exists as of beta.14: `prepareAgain`).
- Tell a goal its step is done when the request it was waiting for has succeeded.
- Move a goal on from a question that no longer applies, or ask the real one.
- Retry a task that failed for an outside reason that has cleared.
- Run the reconcile jobs now instead of waiting.
- Hand over to System checkup's own repairs for service problems.

Rules:

- A repair that only puts her records right runs after the owner says yes in the chat.
- A repair that sends, deletes, spends or changes access produces the ordinary approval
  card. The debugger never widens what she is allowed to do.
- Every investigation and every repair is written to the audit trail.

### 4. Code-sensitive: she asks

When the cause is a defect in her program, or a repair is not on the list, she stops and
says so, with the finding and three choices:

1. **"Look deeper with a coding model."** She reruns the diagnosis with a stronger model
   for this one investigation. Needs a second model slot (today there is one, `primary`);
   switching the main model already exists as a settings card.
2. **"Write the handoff."** A file he can give to Claude: what he asked, the timeline, the
   evidence, the cause, where she thinks the fault is, a failing example to turn into a
   test, and what a fix should do from the person's side. It shows him what is in it
   before it leaves the server, and it goes out through "send to my devices".
3. **"Leave it."** She files it in her own list of known problems so it is not lost.

She does not edit her installed program, restart into changed code, or push anything.

### 5. Hidden before release

One switch, `Debugger`, in the same place as the others (`apps/web/src/lib/flags.ts`,
`Flags.cs`), plus a server check so the tools are not offered to the model when it is
off. Off by default. Owner only when on. Nothing in menus; it is reached by asking her.

## What step one cannot do, on purpose

- **Fix code.** It finds, explains and hands off. See the steps after this one.
- **Find faults in the model's judgement reliably.** It sees what she said and which
  tools ran; it can show she answered without checking, not why the model chose to.
- **See the installer.** Two of today's bugs were in the installer, before Josi runs.
- **Point at source lines with certainty.** The installed program has no source. See the
  first decision below.

## The steps after this one

| Step | What it adds | The new risk |
|---|---|---|
| **1. Debugger (this plan)** | Asked, she investigates, repairs her records, hands off code | Low: reads, and fixed repairs |
| **2. She notices by herself** | Watchers for the patterns in section 2 (a goal waiting on something already done; an expired request nobody was told about; an answer that named a card no tool made). She raises it; she does not act | Noise, if the watchers are loose |
| **3. She proposes the change** | With a copy of her source and the coding tools she already ships with, she writes the fix and its test on a branch and shows the difference. A person merges and builds | She can be wrong convincingly; needs review |
| **4. She heals** | Safe repairs run on their own with a report afterwards; code changes still wait for a person | Trust; needs a record of step 2 and 3 being right |

Step 2 is the one that would have caught today's goal problem without anyone asking.

## What to build, in order

1. The case file collector and its redaction, with tests built from today's four cases.
   Alongside it, reading her own source through the linked repository at the build's
   commit (decision 1).
2. The report format and the five causes; the tool offered only to the owner, only with
   the switch on.
3. The repair list above, each with preview, undo and audit.
4. The handoff writer.
5. The second model slot and "look deeper".
6. A page under System checkup that lists past investigations (hidden with the switch).

Rough size: items 1 to 4 are about a week of work for one session; 5 and 6 a few days
more. Items 1 and 2 alone already give "what went wrong and why", with no repairs.

## Tests that decide whether it works

Replay today's cases from gate and check her report names the right cause:

1. Expired approval, "show me the card again", no card. Cause: stuck state. Repair offered.
2. "send it now" answered with "use the card above". Cause: her own answer, plus a defect.
3. Email sent, goal still asking for approval, reply never looked at. Cause: defect. Repair
   offered for the stuck goal; handoff offered for the cause.
4. A send refused by Google. Cause: outside Josi. No repair offered.
5. A healthy conversation. She says nothing is wrong.

## Decisions for Roman

1. **How does she see her own source? DECIDED (Roman, 2026-11-10): connect the
   repository.** The owner links the Josi repository as a developer service; she reads the
   real source at the commit her build stamp names, read-only. What follows from that:
   - The handoff can quote the file, function and lines, and say which commit it read.
   - On a server with no repository linked she still investigates and repairs; the
     handoff says "the part that handles approvals" and tells the owner linking the
     repository would sharpen it.
   - Read-only is enough for step one. Writing (a branch, a pull request) belongs to
     step 3 and is a separate permission then.
   - The repository is private, so its contents are treated like any connected account:
     quoted to the owner and into the handoff, never to other members.
   - To check before building: that the developer-service connection for GitHub can read
     a private repository at a given commit, and what it costs in requests.
2. **Which stronger model, and who pays?** A second model slot the owner fills, used only
   for "look deeper". Or simply switching the main model for a while.
3. **May a records-only repair run on a spoken yes, or always on a card?** I'd allow the
   spoken yes: these repairs send nothing and can be undone.
4. **Where does the handoff go?** To his devices as a file is the plan. Also straight to
   GitHub as an issue, later?
5. **Whose conversations?** Step one is the owner debugging his own. Members' problems
   would need their consent each time.
6. **Does it ship in the next beta behind the switch, or stay on a branch?**

## Where this plan lives

`docs/JOSI_DEBUGGER_PLAN.md` on `linux/josi-server`. The problems that prompted it are in
`docs/LINUX_FIX_LIST.md` under "TO FIX, in order". The debugger is shared code (agent,
core, web), not Linux-only, so Windows and the Mac get it with the packages.
