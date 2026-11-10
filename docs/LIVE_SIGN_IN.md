# Sign-in cards: you sign in for Josi

The rule (docs/JOSI_IS_THE_INTERFACE.md): Josi never reads, copies, speaks or
stores a secret. When she needs a login she cannot do, she opens a card in
chat. You press Open and sign in yourself, on a live view of her screen
(a website) or in a terminal (a command such as `gh auth login`). What you type
goes straight to the program. Her model never sees the screen, the keys or the
terminal output; it only learns whether you finished.

## Who may

The owner (super admin) by default. The owner can grant named people the same
(`live_signin_grants`, migration 0123), by asking Josi in chat
(`propose_josi_setting_change`, area `live_signin_grant`) or on the PC Control
page. A grant means seeing Josi's whole browser (it shares one Chrome profile,
so it can show the owner's logins too): the grant card says so.

## The card

Josi's tool `request_sign_in` (packages/agent/src/signInTools.ts) creates a
settings-change proposal, area `sign_in_card`, whose `card` is:

```json
{ "kind": "sign_in", "mode": "browser" | "terminal", "pcId": "linux-…",
  "title": "Sign in to GitHub", "intro": "why Josi needs it, plain words",
  "url": "https://github.com/login" | null,       // browser: opened first
  "command": "gh auth login" | null,              // terminal: exactly what runs
  "runAs": "roman" | null,                        // terminal: the Linux user
  "done": "shown after you press Done" }
```

It appears in chat like the credential cards (web: `components/SignInCards.tsx`,
listed by `GET /api/settings-changes`, `area === 'sign_in_card'`, `canApprove`).
Open → a live session; Done → the proposal is `applied` and a note is written
into the thread ("Signed in…"); Cancel → `denied`.

## Owner routes (`/api/live-signin`, session or bearer auth; owner or granted)

| Route | |
|---|---|
| `GET /access` | `{allowed, owner}` |
| `POST /sessions` `{cardId}` | open the card's session → `{id, kind, pcId, title, state}`. One active session per PC and kind: a second gets 409. |
| `GET /sessions/:id` | `{id, kind, pcId, title, state: 'starting'\|'ready'\|'ended', width?, height?, error?, command?, runAs?}` |
| `GET /sessions/:id/frame?after=<seq>&wait=<ms ≤ 8000>` | browser: `200 image/jpeg` + headers `X-Frame-Seq`, `X-Frame-Width`, `X-Frame-Height`; `204` if nothing newer; `410` if ended |
| `GET /sessions/:id/output?after=<cursor>&wait=<ms ≤ 8000>` | terminal: `{cursor, data, running, exitCode}`; `data` is raw text with ANSI codes, `cursor` counts characters |
| `POST /sessions/:id/input` `{events:[…]}` | ≤ 64 events per call, see below |
| `POST /sessions/:id/end` `{outcome: 'done'\|'cancelled'}` | ends it, settles the card, writes the note |

Browser events (coordinates are pixels of the frame the person saw, the
executor scales them to the screen): `{t:'click',x,y,button?:1|2|3,count?:1|2}`,
`{t:'move',x,y}`, `{t:'scroll',x,y,dy}` (dy > 0 scrolls down, in wheel ticks,
|dy| ≤ 20), `{t:'text',text}` (≤ 2000 characters, typed as is), `{t:'key',key}`
(`Return`, `Tab`, `BackSpace`, `Escape`, `ctrl+a`, `ctrl+v` … xdotool names).
Terminal events: `{t:'data',data}` (raw bytes for the pseudo-terminal, ≤ 4096),
`{t:'resize',cols,rows}`.

Sessions live in the API process only: the latest frame, a 256 KB terminal
ring, a queue of input events. Nothing is written to the database, a log or the
model's context. Idle for 10 minutes or 60 minutes in all ends one.

## Executor routes (signed like every `/executor/*` route)

`GET /api/admin/pc-control/executor/live` → `{sessions:[{id, kind, state, title,
url?, command?, runAs?}]}` for this PC (state `starting` or `ready`).

`POST /api/admin/pc-control/executor/live/:id/sync` with
`{ready?: true, error?: string, frame?: {width, height, jpegBase64},
output?: {data, running, exitCode}}` → `{input: [events], ended: boolean}`.
One signed round trip both ways. While a session exists the executor calls it
about four times a second (browser: only sends a frame when the picture
changed, at least one per second; terminal: sends output as it comes). The
executor stops a session the moment `ended` is true or the owner route ends it.

## What the PC service does

Browser: on Josi's hidden screen (`display.json`), frames from ImageMagick
(`import -window root`, JPEG, at most 1280 wide, quality 60), input through
`xdotool` after scaling the click to screen pixels. If the card has a URL it is
opened first in a new tab of Josi's own Chrome (same `--user-data-dir`), so the
sign-in lands in her profile. Terminal: a pseudo-terminal like `pc_terminal_*`,
running exactly `command` as the PC user through `bash -c` (not an open shell),
120x36 until resized; the session reports the exit code and stays open until the
person ends it.

The PC must be paired, enabled and online, like every PC action. The executor
adds a line to the PC's activity log when a session opens and closes (no
content).

## Josi's side

`request_sign_in` is offered only when PC control is on and the person may sign
in. The tool answers "card open, wait" and the note written when the person
finishes says "signed in" or "cancelled". To check, she uses ordinary tools
(`gh auth status` through `pc_run_command`, or `browser_open_page`), under the
usual permissions.
