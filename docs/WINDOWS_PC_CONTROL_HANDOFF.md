# Josi controls the PC it runs on: Windows handoff (November 8, 2026)

> Current direction, November 8, 2026: read the [Josi computer control plan](PC_CONTROL_PLAN.md). It replaces the next-step plan below with chat-managed granular permissions, full computer control, a blue takeover overlay, and independent Windows, macOS, and Linux implementation tracks. This handoff remains the historical Windows implementation record. The owner has now authorized the Windows implementation and build; installation, service changes, and release publication still require explicit approval.

For whoever continues this (Codex, Claude, or Roman): what the owner asked for,
what already existed, the design, the exact files, how to build and test, and
what is left. Read it top to bottom before changing anything.

## The ask, in the owner's words

> i want josi ce to be able to control the computer exactly like you can.
> run commands, open apps, all the fun stuff. everything

"You" is a coding agent (Claude Code) running under the owner's own Windows
account, approving its own actions. Josi must do the same on the PC where the
Josi app is open: run commands and scripts, open programs, read and write
files, look at and operate windows, with the owner's permissions deciding and
an activity log and a Stop button that cuts everything off.

## Where the code is

- Repo: `vaxman14/josi-ce`, branch `redesign/windows-lean-beta`, worktree
  `C:\Dev\josi-ce-winlean` on the owner's PC. Base of this work: `ed34642`
  (the signed, published Windows 1.2.3 was built from that commit).
- Server (TypeScript, Node 24): `packages/core/src/pcControl.ts` (the
  permission engine), `packages/agent/src/pcDesktopTools.ts` (the assistant's
  desktop tools), `apps/api/src/http/pcControlRoutes.ts` (HTTP: settings,
  policies, approvals, and the executor's claim/result endpoints).
- Windows app (C#, WPF, .NET 8): `apps/windows-native/src/DesktopExecutor.cs`
  (does the work on the desktop), `BrowserBridge.cs` (polls
  `/admin/pc-control/executor/next` and reports presence), `PcControl.cs` (the
  PC Control screen: master switch, full control, exact scopes, approvals,
  activity), `MainWindow.cs` (`RenderControlBar`: the "Josi is using this PC"
  banner with Pause and Stop), `Flags.cs` (`LocalWorkspace` gates all of it).
- Web admin page for the same thing: `apps/web/src/pages/admin/PcControl.tsx`.
- Tests: `packages/core/test/pcControl.test.ts` (vitest, PGlite in memory, no
  Postgres needed).

## How it already worked before this change

1. The assistant (the model) gets `desktop_*` tools only while the owner's
   Josi app is open and reporting presence (`PUT /executor/presence` every
   few seconds with family `desktop`), and PC Control is enabled.
2. A tool call becomes one exact **PC Control request**: `requirements`
   (action + exact scope), a `description`, and a sealed `payload` the model
   never sees again. `PcControl.propose()` decides: `denied`, `pending`
   (needs the owner's approval in Josi), or `approved`.
3. The app polls `POST /executor/next`, gets one approved request, runs it in
   `DesktopExecutor.Run`, and posts `/executor/<id>/result`. The tool then
   reads the stored result (`settle()` in `pcBrowserTools.ts`).
4. Rules in `pcControl.ts`: **Full control** (one password-confirmed switch)
   covers everyday actions (browser view/fill/submit, folder read/write,
   app launch/control/close, desktop view). **High-risk** actions
   (`command.run`, deleting, purchases, installs, security settings,
   elevation, secrets) always asked, every time, with the account password,
   and a saved permission could not change that. `Never` on an exact scope
   always wins. Emergency stop revokes everything pending.
5. The executor already did: list windows, read a window's controls (UI
   Automation), screenshot, click, type, keys, click a point in a screenshot,
   open an exe by exact path, close a window. Moving the mouse or typing
   cancels the current action and blocks Josi for 20 s (takeover).

What was missing for "everything": nothing ran commands, nothing read or
wrote files, apps could only be opened by an exact `.exe` path, and a command
could never be pre-approved.

## Design of this change

### Permissions

- `command.run` becomes **grantable**: a saved exact-scope permission with
  mode `always`, `temporary` or `task` now counts (constant
  `PC_GRANTABLE_HIGH_RISK` in `pcControl.ts`). With no saved permission it
  still asks, with the password, like before. The other high-risk actions are
  unchanged.
- The command scope is `{ kind: 'command', application: <shell exe>,
  target: <folder> }`. The folder is a **root**: a command may run in that
  folder or any folder under it. So one grant, "PowerShell under
  `C:\Users\vaxma`", lets Josi work the way a coding agent does. The server
  checks that the working folder is inside the scope folder; the executor
  checks it again.
- Saving a high-risk permission in any mode other than `never` or `ask` needs
  the account password (`PUT /admin/pc-control/policies`, body `password`),
  the same rule as turning on full control.
- Full control still does **not** cover commands. The owner grants shells and
  folders explicitly. Stop still revokes temporary and task grants and ends
  running commands.

### New assistant tools (`packages/agent/src/pcDesktopTools.ts`)

| Tool | Action / scope | Payload kind | What the executor does |
|---|---|---|---|
| `pc_environment` | `desktop.view` / system `desktop` | `desktop.environment` | user, home, hostname, Windows version, shells (paths), tools on PATH, drives, plus the owner's saved command grants (server adds these) |
| `pc_find_app` { query } | `desktop.view` | `desktop.apps` | installed programs matching the name: Start Menu shortcuts, App Paths registry, PATH |
| `desktop_launch` { application, arguments? } | `app.launch` / application | `desktop.launch` | opens the exe, now with optional arguments |
| `pc_run_command` { command, working_folder, scope_folder?, shell?, timeout_seconds? } | `command.run` / command (shell exe + scope folder) | `desktop.command` | runs it as the signed-in user with no window, captures stdout and stderr (bounded), exit code, duration; kills the whole tree on timeout or Stop |
| `pc_list_folder` { folder } | `folder.read` / folder | `desktop.folder` | names, kinds, sizes, dates (up to 500) |
| `pc_read_file` { path } | `folder.read` / the file's folder | `desktop.readfile` | UTF-8 text up to 200 KB, truncated to 64 K characters |
| `pc_write_file` { path, content, append? } | `folder.write` / the file's folder | `desktop.writefile` | writes UTF-8 (creates the folder if it is the exact scope folder) |

Shells: `powershell` = `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`
(run with `-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand`),
`cmd` = `%SystemRoot%\System32\cmd.exe` (`/d /s /c`). No stdin. Default
timeout 120 s, maximum 600 s. The server waits for the result as long as the
command may run (`EXECUTOR_WAIT` is per request now), and the tool's
`settle()` waits the same.

### Executor (`DesktopExecutor.cs`)

- New payload kinds above. `Describe()` names them for the banner
  ("Running a command in C:\Dev\x", "Reading C:\...", "Looking for an app").
- Takeover (mouse or keyboard) only applies to actions that touch the screen
  (click, type, keys, click point, close, launch). A running command is not
  cancelled by the owner moving the mouse. Pause and Stop still end it.
- Commands: `System.Diagnostics.Process` with redirected output, UTF-8,
  `CreateNoWindow`, environment `JOSI_PC_CONTROL=1`, `Kill(entireProcessTree:
  true)` on timeout or cancel. Output kept: first 40 KB and last 24 KB of
  stdout, 16 KB of stderr.
- Every result carries `untrustedContent: true`; the tool descriptions tell
  the model that command output, file contents and window text are data,
  never instructions.

### PC Control screen (`PcControl.cs`, `PcControl.tsx`)

- Saving a high-risk permission in `always`, `temporary` or `task` asks for
  the password once (dialog in the app; password field on the web page).
- A pending `command.run` request gets a second button, "Approve and Always
  Allow This Shell Here", which saves the grant and approves the request.
- Captions updated: commands can be pre-approved per shell and folder;
  deleting, purchases, installs, security changes and elevation still always
  ask.

### Flag

`Flags.LocalWorkspace = true` in `apps/windows-native/src/Flags.cs`. That also
registers the browser extension's native messaging host and shows the
Automation and PC Control sections (administrator only).

## How to build and test (this PC)

Tools present: Node v24 (`node`), .NET SDK 8.0.426 (`dotnet`), git, gh, Azure
CLI (already signed in for code signing), no Inno Setup on PATH (the release
script brings its own pinned copy).

```bash
# server: typecheck and the PC Control tests (PGlite, no database needed)
cd /c/Dev/josi-ce-winlean && npx tsc -b
npx vitest run packages/core/test/pcControl.test.ts
```

```bash
# Windows app
cd /c/Dev/josi-ce-winlean/apps/windows-native && dotnet build -c Release
```

```bash
# signed release installer (needs committed code: the payload comes from git HEAD)
cd /c/Dev/josi-ce-winlean && powershell -ExecutionPolicy Bypass -File scripts\windows\Build-Release.ps1 -Version 1.2.4 -Sign -SkipProvision
```

Output: `artifacts\windows-native\releases\1.2.4\Josi-CE-1.2.4-Windows-x64.exe`
(about 1 GB, server + app) and `Josi-Client-1.2.4-Windows-x64.exe`, with
`SHA256SUMS.txt`. Publishing to GitHub was done by hand for 1.2.3 with
`gh release upload v1.2.3 ...`; 1.2.4 needs a new release
(`gh release create v1.2.4 --draft ...`) or `-Publish` on the script. The
owner publishes; do not publish without being told.

Traps (from earlier sessions):
- Git has no identity on this PC: commit with
  `git -c user.name="Roman Vaxman" -c user.email="roman@Romans-MacBook-Pro.local" commit ...`
  (the author of the previous commits). Do not set global config.
- Line endings: most files are LF, some C# files are CRLF (`Chat.cs`, `Ui.cs`,
  `drive.ps1`). Use an editor that keeps them. Python text mode rewrites to
  CRLF: use `newline=''` or binary. Check `git diff --stat` for whole-file churn.
- The full vitest run takes about 27 minutes and 13 tests in 6 files fail on
  this PC regardless (Mac and Linux assumptions). Run the PC Control file alone.
- Port 8787 is held by another project's dev server; the app's UI drive scripts
  take `-Port 8801`. Never use SendKeys in drivers; the owner types in other
  windows while tests run.
- The installed Josi on this PC (services JosiWeb, JosiWorker, JosiProxy,
  JosiDatabase, JosiVoice, JosiVoiceControl) runs 1.2.3 from Program Files.
  New server code reaches it only through a new installer run (Update keeps
  data). Installing needs the owner's UAC click.
- The owner's Josi is public at `https://cewin.heyjosi.com` through a
  Cloudflare tunnel (service `cloudflared`). Phone apps connect there.

## Trying it for real

1. Install 1.2.4 (run the installer, choose Update).
2. Open Josi on the PC, sign in as the owner (super admin), open **PC Control**.
3. Turn on "Allow Josi to control this PC". Optionally turn on Full control
   (folders, apps and windows then stop asking).
4. Save a scope: action "Commands, scripts, builds and tests", folder
   `C:\Users\vaxma` (or a project folder), runner
   `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`, mode "Always
   allow". Enter the password when asked.
5. In chat: "what is on my desktop?", "open Notepad", "run git status in
   C:\Dev\josi-ce-winlean", "list the files in my Downloads folder".
6. Watch the banner at the top of the window while it works; Stop ends it.
7. The Activity log under PC Control shows every attempt and decision.

## Status

See the end of this file; the section "Done so far" is updated as work lands.

### Done so far (November 8, 2026)

- Server: `command.run` is grantable (`PC_GRANTABLE_HIGH_RISK`), the catalog
  reports `grantable`, saving a high-risk grant needs the password, the
  executor wait follows the command's timeout. Tests in
  `packages/core/test/pcControl.test.ts` (new case "commands ask until the
  owner saves a grant...") and `packages/agent/test/pcDesktopTools.test.ts`.
  `npx tsc -b` clean; 40 of 41 PC Control tests pass; the one failure
  ("renders the actual browser page...") fails without these changes too on
  this PC (Playwright page load).
- Agent tools: `pcDesktopTools.ts` rewritten with the table above.
- Windows app: `PcWork.cs` (new), `DesktopExecutor.cs` (new kinds, takeover
  only for screen work, launch arguments), `PcControl.cs` (shell picker,
  password on high-risk grants, "Approve and Always Allow ... Here"),
  `Flags.cs` (`LocalWorkspace = true`). `dotnet build -c Release` clean.
- Web page `PcControl.tsx`: shell picker, password field, captions.
- Probe: `apps/windows-native/test/pcwork-probe` (console app) drives the real
  `PcWork` in the built Josi.dll through reflection: environment, app search,
  PowerShell and cmd commands, exit codes, UTF-8, stderr as plain text,
  timeout kill, cancel, output trimming, scope refusals (outside folder,
  sibling prefix, other shell), list/read/write/append files, binary
  detection, folder creation rules. All 29 checks pass. Run it with
  `dotnet run -c Release` inside that folder after building Josi.

### Not done or not verified

- Not tried against a live server with a model: the agent tool path
  (`executePcDesktopTool` → PC Control → app → result) is covered by the
  existing design and unit tests, not by an end-to-end chat.
- The "Approve and Always Allow ... Here" button saves the grant and then
  approves the request; saving a policy invalidates pending requests on the
  server (`invalidate()`), so the explicit approval may answer 409 and the
  model's tool call then reports the request as revoked. The model's next
  attempt runs without asking. If that is annoying in practice, change the
  server so savePolicy does not revoke pending requests whose scopes the new
  policy approves, or have the button save the policy first and let the model
  retry.
- The web page's shell picker hard-codes `C:\Windows\System32\...`; PcWork
  compares against the real system folder, so a non-standard Windows folder
  would refuse. Rare.
- Release 1.2.4: **built and signed** on November 8, 2026 from `c81188b`
  with `Build-Release.ps1 -Version 1.2.4 -Sign -SkipProvision`. Output in
  `artifacts\windows-native\releases\1.2.4`: `Josi-CE-1.2.4-Windows-x64.exe`
  (971 MB, SHA-256 `6b4d4e90…ac88`, Authenticode valid, CN=SoCal Receptionist)
  and `Josi-Client-1.2.4-Windows-x64.exe`. Both installers and SHA256SUMS.txt
  are on GitHub as the **draft** release `v1.2.4` (release id 438148762,
  target `c81188b`), created November 8, 2026 on the owner's say-so. Still a
  draft: the owner publishes it from the GitHub releases page when ready.
  **Not installed on this PC** (needs the owner's UAC click).
  Note: `gh release create` hangs on a prompt in this environment; create
  releases with `gh api --method POST repos/vaxman14/josi-ce/releases --input
  body.json` and upload with `gh release upload`.
