# Driving the Josi Windows app from an automation tool

This is for a tool such as ClipForge that starts the app, clicks through a
storyboard, waits for states and records the screen, and has to get the same
picture on every take. Nothing here changes the app for a person who starts
it normally; demo mode is a separate launch against a separate server.

## 1. The stack

- **Windows app** (`apps/windows-native`): WPF on .NET 8, native controls only.
  Every screen is built in code through the `Ui` helpers (`src/Ui.cs`). There
  is **no WebView2 and no hosted browser content** anywhere in the Windows
  app, so UI Automation (UIA) sees every control directly. Windows Hello
  prompts and the Windows file and folder pickers are the only non-WPF
  windows it opens.
- **Server** (`apps/api`, Express and TypeScript; `apps/worker` runs replies,
  folder indexing and background jobs). The app signs in with a bearer
  session over HTTP on localhost, header `x-josi-client: native`.
- **Phone side**: the web app at `apps/web` (React), opened in a mobile
  browser against the same server. It has no `data-testid` attributes yet;
  see "Not automated yet".
- **Browser extension** (`apps/browser-extension`): takes part only in PC
  Control of a browser tab (attach a tab, read and act in it). No flow in this
  document needs it; the demo server has it switched off.

## 2. Demo mode

### What it is

A second development server, the **demo server**, in `C:\Dev\josi-demo`
(API `http://localhost:8090`, PostgreSQL on port 15433), with its own data
folder, database and account. It shares the development server's pinned
tools in `C:\Dev\josi-dev` (PostgreSQL binaries, CLIs, Python, ffmpeg) but
never opens `C:\Dev\josi-dev\data`, and the installed product's data in
ProgramData is not involved at all. Both servers can run at the same time.

Its model is **`scripts\windows\demo\replay-model.mjs`**: a small server on
`http://127.0.0.1:18090/v1` that speaks the OpenAI chat-completions shape
and answers from a replay file. The demo server is set up with it as an
"OpenAI-compatible" model on loopback, so the Josi server code is untouched
and passes its own capability check against it.

### One-time creation

```bash
powershell -ExecutionPolicy Bypass -File scripts\windows\demo\New-DemoServer.ps1
```

Then build the app once:

```bash
dotnet build apps\windows-native -c Release
```

### Start, open, reset, stop

```bash
powershell -ExecutionPolicy Bypass -File scripts\windows\demo\Start-DemoServer.ps1
```

Starts the replay model, the demo database, API and worker, and on the first
start seeds the demo (about 40 seconds). Then:

```bash
powershell -ExecutionPolicy Bypass -File scripts\windows\demo\Open-DemoApp.ps1
```

opens the app in demo mode. Between takes:

```bash
apps\windows-native\bin\Release\net8.0-windows10.0.19041.0\Josi.exe --demo-reset
```

restores the seeded state in about 15 seconds without restarting the server.
If a demo copy of the app is open, it does the reset itself (status reads
`state=resetting`, then `state=ready`) and lands on the empty Conversations
page. If none is open, the command does the reset and exits. The same
reset is `Reset-Demo.ps1`. To stop everything:

```bash
powershell -ExecutionPolicy Bypass -File scripts\windows\demo\Stop-DemoServer.ps1
```

### Launching the app directly

`Josi.exe --demo` or the environment variable `JOSI_DEMO=1`. Flags:

| Flag | Effect |
|---|---|
| `--demo` | Demo mode against `JOSI_DEMO_ROOT` (default `C:\Dev\josi-demo`). |
| `--demo-root <folder>` | Another demo root. |
| `--open <section>` | Open a sidebar section once signed in: `chat`, `tasks`, `approvals`, `calendar`, `contacts`, `files`, `reminders`, `memory`, `personalization`, `templates`, `workflows`, `automation`, `migration`, `connections`, `vault`, `channels`, `usage`, `account`, `family`, `apps`, `overview`, `checklist`, `models`, `people`, `connectors`, `custom-apis`, `workflow-providers`, `policy`, `parental`, `storage`, `mail-settings`, `backups`, `voice-box`, `pc-control`, `improvements`, `workspace`, `network`, `maintenance`, `audit`, `server`. |
| `--thread <id\|n\|title>` | Open a conversation: its id, its 1-based position in the sidebar, or part of its title. |
| `--pc-banner working\|paused\|takeover\|off` | Show the PC Control banner in that state (scripted, see below). |
| `--demo-reset` | Restore the seeded state. |
| `--status` | Print the running demo copy's status as JSON and exit. |

When a demo copy is already open, a second `Josi.exe --demo ...` with these
flags hands them to the open copy and exits, so a scene can be set at any
point: `Josi.exe --demo --thread 2`, then `Josi.exe --demo --open files`.
`Open-DemoApp.ps1 -Open files -Thread 2` passes them through.

### What a demo launch does

- Reads `C:\Dev\josi-demo\demo.json` (written by the seed) for the server
  address and the demo account, points the app at the demo data folder,
  connects and signs in. No Welcome screen, no sign-in screen, no first-run
  setup: the window opens straight into the seeded workspace. Status reads
  `state=ready` when the workspace has loaded.
- Runs under its own instance name (`JOSI_TEST_INSTANCE=Demo`): own window
  mutex, own links pipe, own settings file, own remembered sign-in in
  Credential Manager. It does not register `josi://`, the browser host, Send
  to or notifications, never shows a toast and never opens a browser. A
  person's normal copy of Josi can stay open beside it.
- Window: 1280x800 at (40, 40), set before the window shows. Override with
  `JOSI_DEMO_WINDOW=1280x800+40+40` or a `"window": "1280x800+40+40"` entry
  in `demo.json`. The theme is the app's one dark theme. The app follows the
  monitor's DPI (PerMonitorV2), so record at 100% display scaling for
  identical pixels. Animations (the rocking J) run from a fixed start, so
  they look the same each take.
- No popups on start: the demo account's Vault recovery is already
  confirmed, it has no authenticator, no proposals are pending after a
  reset, and Windows notifications are off.

### The seeded state

`scripts\windows\demo\seed.json` is the whole picture, and `--demo-reset`
rebuilds exactly it:

- Workspace **Josi Demo**, time zone America/Los_Angeles, owner account
  **Dana Demo** (`dana`). Its password is generated at the first seed and
  kept in `C:\Dev\josi-demo\demo.json`; it opens nothing but this demo
  server on loopback.
- Three conversations, newest first in the sidebar: **Shopping**,
  **Launch plan**, **Getting started**, each with one question and its
  canned reply.
- One folder, **Demo Files** (`C:\Dev\josi-demo\sample-files`): three files
  (`launch-plan.md`, `shopping-list.txt`, `notes/meeting-2026-10-28.md`),
  indexed and searchable.
- Three memories.
- PC Control off, no pending approvals, no settings proposals, the replay
  model "josi-demo" set up and ready.

Audit-log entries and model usage counts survive a reset (the demo database
keeps them); nothing in the storyboard screens shows them.

### The replay file

`scripts\windows\demo\replay.json`, re-read whenever it changes, so a reply
can be edited between takes without restarting anything:

```json
{
  "delayMs": 1800,
  "perCharacterMs": 4,
  "fallback": "Reply when nothing matches.",
  "replies": [
    { "id": "hello", "prompt": "What can you help me with today?", "reply": "..." },
    { "id": "plan", "match": "summar(y|ise|ize).*(launch|plan)", "reply": "..." },
    { "id": "third", "turn": 3, "reply": "..." },
    { "id": "rename", "prompt": "Rename the workspace to Northwind Demo",
      "toolCalls": [{ "name": "propose_josi_setting_change", "arguments": { "area": "workspace", "summary": "...", "body": { "name": "Northwind Demo", "timezone": "America/Los_Angeles" } } }],
      "afterTools": "Reply once the tool has run." }
  ]
}
```

- A reply is chosen by, in order: `prompt` (the person's message, exact
  apart from case and spacing), `match` (a regular expression over the
  message), `turn` (the message's position in the conversation, 1-based),
  then `fallback`.
- `delayMs` plus `perCharacterMs` times the reply length is how long "Josi
  is thinking" shows. Fixed, so timing is the same on every take; set them
  per reply to override.
- `toolCalls` makes the model call real Josi tools first; the server runs
  them for real against the demo data, then asks the model again and gets
  `afterTools` (or `reply`). This is how the settings-change popup is
  produced for real: `propose_josi_setting_change` creates a real proposal,
  Approve applies it for real on the demo server, and the reset undoes it.
- Josi's own background model calls (memory learning, conversation notes,
  improvement review) and its five capability checks are answered inside
  `replay-model.mjs` with fixed, empty answers, so the demo never learns or
  proposes anything on its own.
- Markdown works as in the app: `**bold**`, `` `code` ``, `[text](https://...)`.

The model's log is `C:\Dev\josi-demo\data\logs\model.log` (which reply was
chosen, and after what delay).

### What runs for real and what is scripted

| Thing | In demo mode |
|---|---|
| Replies | Scripted (replay file). |
| Settings-change proposals, the popup, Approve and Decline | Real, against the demo server, triggered by a scripted tool call. |
| Folders, files, indexing, search, memories, approvals, tasks | Real, on demo data. |
| PC Control permissions page | Real. Turning control on and adding scopes is real on the demo server; a reset turns it off again. |
| PC Control actions on the desktop | Real executor, if a scripted reply calls a `desktop_*` tool and the request is approved. Not seeded; `--pc-banner` is the scripted alternative for the banner itself. |
| PC Control banner | `--pc-banner working|paused|takeover` shows it without any desktop action. Pause, Resume and Stop Josi then move between those states inside the app only (Stop clears it and sets `pc=stopped`). |
| Voice, browser extension, email, cloud accounts | Not set up on the demo server. |

## 3. Automation ids

Every interactive or meaningful element has an `AutomationProperties.AutomationId`,
readable through UIA (Inspect, FlaUI, pywinauto, PowerShell's UIAutomationClient).
Names are set wherever a control had none. Ids never depend on position.

### How ids are formed

- **Fixed ids** are set by hand and are the ones to script against; they
  survive label changes. Listed below.
- **Derived ids** cover everything else: every button, link, text box,
  password box, checkbox, drop-down and segment the `Ui` helpers build gets
  `josi.<screen>.<label>` automatically, where `<screen>` is the sidebar key
  of the page (`files`, `memory`, `models`, `pc-control`, ...) or the kind of
  sheet (`confirm`, `add-folder`, ...), and `<label>` is the control's own
  text in lower case with words joined by `-` (`Refresh` on Files is
  `josi.files.refresh`, `Save Storage Settings` on Storage is
  `josi.storage.save-storage-settings`). A second control with the same label
  on the same screen gets `.2`, a third `.3`. These change when a label is
  reworded; prefer a fixed id where one exists, and ask for one to be fixed
  if a storyboard needs it.
- Containers that have no UIA presence of their own (panels, borders) are
  wrapped in a group with the id and a Name that carries the state, so rows
  and banners can be found and read.

### Fixed ids

**Main window and bars**

| Id | What |
|---|---|
| `josi.main` | The main window. |
| `josi.status` | The status line (section 4). Its Name and text are the status. |
| `josi.content` | The screen area (Welcome, Sign in, Setup or the workspace). |
| `josi.error` | The error bar (Name = the message), with `josi.error.text` and `josi.error.dismiss`. Absent when there is no error. |
| `josi.busy` | The "working" indicator at the bottom while a request runs (Name = what it is doing). |
| `josi.pc-control.banner` | The PC Control banner (Name = its sentence). Buttons: `josi.pc-control.pause`, `josi.pc-control.resume`, `josi.pc-control.continue` (Let Josi Continue), `josi.pc-control.stop` (Stop Josi). |

**Welcome, Sign in, Setup**

| Id | What |
|---|---|
| `josi.welcome` | The Welcome screen. `josi.welcome.open` is Open Josi; `josi.welcome.setup` is Set Up on This PC; `josi.welcome.server-status` is the server line; `josi.welcome.refresh-status`, `josi.welcome.start`, `josi.welcome.stop`, `josi.welcome.restart` the server controls. |
| `josi.login` | The sign-in screen: `josi.login.identifier`, `josi.login.password` (the password box is its child Edit), `josi.login.code` (authenticator code), `josi.login.submit` (Sign In / Verify), `josi.login.back`, `josi.login.google`, `josi.login.forgot`, `josi.login.reset-link`. |
| `josi.setup` | First-run setup; its fields and buttons derive ids under `josi.setup.`. |

**Sidebar**

| Id | What |
|---|---|
| `josi.sidebar.item.<section>` | One per section, keys as in the `--open` table (`josi.sidebar.item.files`). ItemStatus is `selected` on the current one. |
| `josi.sidebar.new-conversation` | The compose button. |
| `josi.sidebar.search` | Search conversations. |
| `josi.sidebar.thread.<n>` | The n-th conversation in the list (newest first); Name = title, HelpText = its id, ItemStatus `selected` when open. |
| `josi.sidebar.account` | The signed-in name. `josi.sidebar.sign-out` signs out. |

**Conversations (chat)**

| Id | What |
|---|---|
| `josi.chat.title` | The conversation title. `josi.chat.model` the model name. |
| `josi.chat.composer` | The message box (Edit). Set its value, then invoke send. |
| `josi.chat.send` | The primary button: Send message, Retry delivery, Voice chat or End voice (its Name says which). |
| `josi.chat.attach`, `josi.chat.dictate`, `josi.chat.voice-settings` | Attach, Dictate, voice settings. |
| `josi.chat.attachment.<n>.remove` | Remove the n-th draft attachment. |
| `josi.chat.empty` | The "What would you like to get done?" state of an empty conversation. |
| `josi.chat.turn.<n>` | Your n-th message (Name = its text); `josi.chat.turn.<n>.text` the selectable text. |
| `josi.chat.reply.<n>` | Josi's n-th reply (Name = its text); `.text`, `.copy`, `.read`, `.knew` (What Josi knew). |
| `josi.chat.thinking` | The "Josi is thinking" indicator, present only while a reply is being written; `josi.chat.thinking.text` is its sentence. |
| `josi.chat.failure.<n>` | The n-th failed-reply card. |
| `josi.chat.hint` | The "Enter to send" line. |

**Sheets and dialogs**

| Id | What |
|---|---|
| `josi.sheet.<kind>` | Every sheet window: `settings-change`, `confirm`, `message`, `password`, `add-folder`, `knew`, `vault-recovery`, `mfa-recovery`, `forgot-password`, `password-setup`, `memory-source`, `voice-settings`; other sheets use their title. |
| `josi.settings-change.title`, `.summary`, `.approve`, `.decline`, `.later` | The settings-change popup. |
| `josi.confirm.ok`, `josi.confirm.cancel` | Any confirmation (the ok button carries the action's label as Name). |
| `josi.message.ok` | A message. |
| `josi.password.input`, `.ok`, `.cancel` | The account-password prompt. |
| `josi.add-folder.page` | The Add a Folder sheet's current page (Name: `sources`, `pc`, `server-folders`, `cloud`). `josi.add-folder.source.pc`, `.source.server`, `.source.<provider>` choose where; `josi.add-folder.add` adds a PC folder, `josi.add-folder.use` a cloud folder; `josi.add-folder.error` shows a refusal. Toggles and Back/Cancel derive. |

**Files (Folders)**

| Id | What |
|---|---|
| `josi.files.add-folder` | Add a Folder (also `josi.files.add-folder.empty` in the empty state). `josi.files.refresh`. |
| `josi.files.folder.<n>` | The n-th folder row; Name = `<path> · <Active|Paused> · <syncing|synced|not-indexed>`. `.name`, `.status` (Name = `Active · synced`), `.browse`, `.sync` (Sync Now), `.searchable`, `.remove`. |
| `josi.files.entry.<n>` | The n-th file or folder while browsing (Name = its name). |
| `josi.files.filter`, `josi.files.receipt` | The search box; the receipt line after a change. |

**Models**

| Id | What |
|---|---|
| `josi.models.primary.state`, `josi.models.fallback.state` | Name reads `Ready`, `Not signed in`, `Needs a capability check`, `Check failed` or `Not set up`. |
| `josi.models.<role>.provider`, `.set-up`, `.sign-in`, `.change`, `.check`, `josi.models.fallback.remove` | The slot's provider name and buttons. |

**PC Control page**

| Id | What |
|---|---|
| `josi.pc-control.enabled` | Allow Josi to control this PC. `josi.pc-control.full-control` the full-control switch. |
| `josi.pc-control.stop-control` | Stop Control and Revoke Temporary Access. |
| `josi.pc-control.save-scope` | Save Exact-Scope Permission. |
| `josi.pc-control.request.<n>` | The n-th action awaiting approval; `.approve`, `.deny`. |

Everything else (Task Manager, Approvals, Memory, Vault, People, the
administration pages, the setup forms) is reachable by derived ids and by
Name. A quick way to see what a screen exposes is UIA's Inspect, or
`powershell` with `UIAutomationClient` listing descendants whose
AutomationId starts with `josi.`.

## 4. Observable states

Wait on these instead of sleeping.

### The status line

`josi.status` (Text; Name and text are the same line), updated as soon as
anything changes. In demo mode the same values are also written to
`C:\Dev\josi-demo\state\app-status.json`, which `Josi.exe --status` prints.

```
state=ready;screen=workspace;section=chat;thread=<id>;turn=idle;popup=none;popup-result=;pc=off;auth=signed-in;folders=synced;busy=0;error=0;activity=
```

| Key | Values |
|---|---|
| `state` | `starting`, `waiting` (Welcome shown, nothing in progress), `connecting`, `loading` (signed in, workspace not loaded yet), `ready` (signed in, workspace loaded, server answered), `resetting`, `error` (demo sign-in failed). |
| `screen` | `connect` (Welcome), `login`, `setup`, `workspace`. |
| `section` | The sidebar key of the open section. |
| `thread` | The open conversation's id, empty when none. |
| `turn` | `idle`; `running` while a reply is being written; `done` once the reply to the message sent from this app has arrived; `failed` when it failed. Back to `idle` when another conversation is opened. |
| `popup` | `none`, or the open sheet's kind (`settings-change`, `confirm`, `message`, `password`, `add-folder`, ...). |
| `popup-result` | How the last sheet ended: `settings-change:approved`, `settings-change:declined`, `settings-change:later`, `confirm:ok`, `confirm:cancelled`, `password:ok`, `password:cancelled`, `message:ok`. Cleared by a demo reset. |
| `pc` | `off`, `working`, `paused`, `takeover`, `stopped` (after Stop Josi, until Josi works again). |
| `auth` | `signed-in` or `signed-out`. |
| `folders` | `none`, `syncing`, `synced`; set when the Files page loads, when Sync Now or Make Searchable is pressed, and (demo mode) every two seconds while a folder is syncing. |
| `busy` | `1` while a request runs. `error` | `1` while the error bar shows. |
| `activity` | The busy indicator's sentence. |

### Per-element states

| State | Where to read it |
|---|---|
| App ready | `state=ready` in the status, or `josi.sidebar.item.chat` present and `josi.busy` absent. |
| Turn in progress | `josi.chat.thinking` present; `turn=running`. |
| Reply finished | `josi.chat.reply.<n>` appears and `josi.chat.thinking` disappears; `turn=done`. |
| Reply failed | `josi.chat.failure.<n>` appears; `turn=failed`. |
| Popup shown / resolved | `josi.sheet.settings-change` window present; `popup=settings-change`, then `popup=none` with `popup-result=settings-change:<decision>`. |
| Folder sync | `josi.files.folder.<n>` Name ends in `syncing` or `synced`; `folders=`. |
| PC Control | `josi.pc-control.banner` Name, its buttons present or absent; `pc=`. |
| Signed in / out | `josi.sidebar.account` present; `auth=`. |
| Models | `josi.models.primary.state` Name. |

## 5. Command-line control

See the flag table in section 2. Examples, with a demo copy open:

```bash
Josi.exe --demo --thread 2
```
```bash
Josi.exe --demo --open files
```
```bash
Josi.exe --demo --pc-banner working
```
```bash
Josi.exe --demo-reset
```
```bash
Josi.exe --status
```

`--status` prints JSON (`state`, `screen`, `section`, `thread`, `turn`,
`popup`, `popupResult`, `pc`, `auth`, `folders`, `busy`, `error`,
`activity`, `summary`, `updatedAt`, `pid`), or `{"state":"not-running"}`
when no demo copy is open. `Josi.exe --help` prints the flags. Flags are
ignored by a normal launch except `--help` and `--status`.

## 6. Where things are

| | |
|---|---|
| Demo root | `C:\Dev\josi-demo` (`demo.json`, `data\`, `sample-files\`, `state\app-status.json`). |
| Demo server | `http://localhost:8090`, PostgreSQL 127.0.0.1:15433, logs in `C:\Dev\josi-demo\data\logs`. |
| Replay model | `http://127.0.0.1:18090/v1`, `scripts\windows\demo\replay-model.mjs`, replies in `replay.json`, log `data\logs\model.log`. |
| Seed | `scripts\windows\demo\seed-demo.mjs`, data in `seed.json`. |
| Scripts | `scripts\windows\demo\New-DemoServer.ps1`, `Start-DemoServer.ps1`, `Stop-DemoServer.ps1`, `Reset-Demo.ps1`, `Open-DemoApp.ps1`. |
| App source | `apps/windows-native/src/Automation.cs` (ids, status, demo flags), `MainWindow.cs` (launch, status, demo start, scene commands). |
| Development server | `C:\Dev\josi-dev`, API 8080, PostgreSQL 15432: untouched by all of this. |

## 7. Not automated yet

- **The web app** (`apps/web`, the phone side) has no `data-testid`
  attributes and no demo mode; a phone storyboard would need both.
- **The browser extension** and PC Control of a browser tab: not set up on
  the demo server, no scripted path.
- **Voice** (dictation, voice chat, Voice Box) is not installed on the demo
  server.
- **Windows file and folder pickers** (Attach, Add a Folder on this PC,
  Download, Save recovery key) and **Windows Hello** prompts are system
  dialogs with their own ids, not Josi's.
- **Approvals page rows, Task Manager cards and the administration pages**
  have derived ids only (`josi.approvals.approve`, `.approve.2`, ...), which
  follow label and order rather than the item.
- **Thread ids change on every reset**; use `--thread <n>` or a title
  rather than an id across takes.
- **Real desktop actions** (Josi clicking in other programs) are not seeded;
  the banner is scripted instead.
- **Keyboard focus**: a sheet such as the settings-change popup opens with
  its primary button focused and takes focus like any new window. Do not
  type at the keyboard while a storyboard runs, or an Enter meant for
  another program can approve the popup. Record on a session nobody is
  typing in.
