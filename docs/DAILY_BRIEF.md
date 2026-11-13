# Daily Brief + Memory

Built 2026-11-12 (Linux beta.25). Shared code: it is in `packages` and `apps/web`, so Windows and the Mac get it when they take those packages.

## What it is

Josi keeps a short notes file for each person, a small task list, and, if the person turns it on, writes to them on her own: a Morning Brief when their quiet hours end and up to two check-ins a day. All of it is local; no cloud.

## The pieces

| Piece | Where |
|---|---|
| Notes, tasks, settings, the due-brief clock | `packages/core/src/briefMemory.ts` |
| Tables | `packages/db/migrations/0135_daily_brief.sql` (`user_brief_notes`, `brief_tasks`, `brief_settings`, `brief_runs`, schedule `brief.tick`) |
| Josi's chat tools and prompt | `packages/agent/src/briefTools.ts` (`note_remember`, `note_forget`, `brief_tasks_list`, `brief_task_add`, `brief_task_update`) |
| The scheduled run | `packages/agent/src/dailyBrief.ts` |
| Worker jobs | `apps/worker/src/jobs.ts` (`brief.tick` every 5 minutes, `brief.run`) |
| Routes | `apps/api/src/http/briefRoutes.ts`, mounted at `/api/brief` |
| Page | `apps/web/src/pages/Brief.tsx`, menu "Daily brief" |

## Memory

One notes file per person, sealed with their own Vault box key (the same sealing My World uses, `sealForOwner`), so the database holds no readable line. Sections: Goals, Rules (only what the person said), People, Open loops, Task status, Talked through (dated one-liners so the brief does not bring up what is settled).

- Josi writes with `note_remember` whenever she learns something durable, and removes with `note_forget`. The notes and open tasks are put in front of the model every chat turn.
- Short and dated: every line carries its day; "Talked through" goes after 21 days, Open loops after 90, Task status after 60; each section is capped (Rules and People 40, Goals 20, the rest 30 to 40). Rules never expire.
- Never stored: passwords and codes, card numbers, ID numbers (`checkNoteText`). Health and money details only when the person explicitly asked (`explicit_request`, or the person typing it on the page).
- A locked Vault box means the notes cannot be read or written; a brief then runs without them and chat says so.

## Tasks

States: working, waiting on you, blocked, done. Josi may move a task between the first three, add a detail, and PROPOSE "done" (`done_proposed`, shown as "Josi thinks it is done"). Only the person marks it done (the page, `PUT /api/brief/tasks/:id`). Done tasks are removed after 14 days.

## The scheduler

`brief.tick` runs every five minutes and calls `claimDueBriefs`. For each person with the brief or check-ins on, in their own time zone (their setting, else the workspace's):

- never inside quiet hours (default 22:00 to 07:00, may cross midnight);
- Morning Brief: once a local day, any time in the five hours after quiet hours end;
- check-ins: from three hours after quiet hours end, at most two a day, at least four hours apart.

Each due brief is claimed with one `update ... where last_brief_day is distinct from today` so two workers never post the same one, and a `brief_runs` row is written. `brief.run` then makes ONE fresh model call (`runDailyBrief`).

## What a run may do

Nothing but write. The model call has no tools at all, so it cannot send, pay, delete or book; the prompt says so and tells it to offer, not act. It is given the notes, open tasks, and what the inbox (last day) and calendar (next 36 hours) show, read through the same permission-checked tools chat uses (`search_email`, `query_calendar`); an account that is off or not connected simply gives "not available". Everything it is given sits inside `<data>` tags and the prompt calls it data, never instructions.

Format: a greeting; "Updates on your current tasks:" as a numbered list; "Tasks I could help with:" at most three. If the model answers in another shape or is unreachable, a plain list is built from the task list instead (a morning brief is never lost to a weak model). A check-in posts only if the model finds something changed, needing the person, or time-sensitive; it answers `SILENT` otherwise, and a check-in that is not well shaped (or has no model) stays silent rather than posting filler.

The brief is posted as a message in a conversation called "Daily brief".

## Settings and the page

`/app/brief`: brief on or off, check-ins on or off, quiet hours, "Send me a brief now" (one a minute), the task list (mark done, remove, add), and "What Josi remembers" with every line readable, editable and deletable and a way to add one. **Both switches start OFF**, because a brief reads the inbox and calendar.

## Not built, and not tried

- Not tried with a real model on a real mailbox (tests use a stand-in model and no account).
- Josi does not yet propose turning the brief on; she does not know the settings exist except through the page.
- Quiet hours and time zone are not yet changeable by asking Josi.
- A brief is posted as a message; there is no push for it beyond what any message gets.
- Managed child accounts get the page like everyone else (their notes are their own).
