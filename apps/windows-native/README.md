# Josi for Windows — native client (0.7.0-windows.1, development build)

A native Windows version of the Josi app, ported from the SwiftUI/AppKit Mac app in
`Windows-Handoff-2026-10-20/source-current/apps/macos-native`. It talks to the same
Josi CE server API, so accounts, conversations, tasks, Vault, memory and settings stay
canonical on the server. The handoff folder was not modified.

## Build and run

Needs the .NET 8 SDK (`winget install Microsoft.DotNet.SDK.8`).

```bash
dotnet build apps/windows-native -c Release
```

Output: `apps/windows-native/bin/Release/net8.0-windows10.0.19041.0/Josi.exe`.

To click through every screen against a local test fixture (needs Node):

```bash
powershell -ExecutionPolicy Bypass -File apps/windows-native/test/drive.ps1
```

`test/mock-server.mjs` is a tiny in-memory stand-in for the CE API (test password
`correct horse battery`). It is a fixture, not a server.

## Framework decision

**WPF on .NET 8** targeting `net8.0-windows10.0.19041.0` (Windows 10 2004 and later;
supported targets are Windows 10 22H2 and Windows 11). The Windows SDK projection gives
direct access to Windows Hello (`KeyCredentialManager`), which is the approved protected
approval boundary. The first prototype used .NET Framework 4.8 because no SDK was
installed; the code moved unchanged except JSON (now System.Text.Json).

## Same rules, design, logo and colors

- Tokens copied exactly from `JosiTheme.swift`: background `#0B111E`, sidebar `#141E30`,
  card `#101728`, raised `#1F283D`, border `#252D41`, orange `#F6831E`, text `#FDF6EA`,
  muted `#9DABBE`. Dark Windows 11 title bar in the same navy.
- Logo: the approved white-J-on-navy master (`josi-mark.png`, `icon-512.png`), also used
  for the `.exe` icon. Product line "Your assistant, on your own server." Publisher
  SOCAL RECEPTIONIST LLC. The retired shepherd mark is not used.
- Pill buttons, rounded cards, rounded composer, status badges, segmented filters and the
  animated J "thinking" indicator (still when Windows animations are turned off).
- Keyboard: Enter sends, Shift+Enter new line, Ctrl+Enter also sends (Windows equivalent
  of Cmd+Enter). IME composition never sends. Ctrl+N starts a new conversation.

## What is implemented (source)

| Area | Status |
|---|---|
| Welcome: this PC (local server) or another computer (HTTPS / localhost) | Done |
| Local server: detect the 6 Josi CE services, Start/Stop/Restart via UAC, run installer for update/repair, open Installed Apps to uninstall | Done |
| First-run setup handoff for a local server + in-app setup steps (owner, domain, model, SMTP, security, telemetry, review, Vault recovery key) | Done |
| Sign in, authenticator (MFA) codes, invitation / password reset | Done |
| Conversations: durable turns with idempotency key + retry, attachments (20 MB), failed-reply cards, goal cards, Markdown, copy, read aloud | Done |
| Voice: dictation and voice chat via the server's Voice Box (16 kHz mic capture), voice settings | Done (untested with real Voice Box) |
| Task Manager: Active / Needs You / History, goal controls (Pause, Continue, Cancel, Confirm), work notes, outcome/limits/retire-step editors, histories, task receipts, failed requests; live progress stream with polling fallback | Done |
| Memory, Vault (personal + Master), Your Settings, Messaging Apps (Telegram, WhatsApp, Slack), Models (+ ChatGPT/Claude subscription sign-in), People, Email Delivery, Backups (private streamed download), Server health | Done |
| Recovery keys / MFA codes: modal, cannot close until saved; written as current-user-only files | Done |
| Automation: redesigned for the current desktop (no VM / storage cards); shows server blockers, Cardinal Rules, permissions and devices **read-only** | Partial — see below |

## Not done (deliberately, per the handoff's scope and safety rules)

- **Desktop control and Chrome tab control.** No Windows executor, native-messaging host
  or extension changes yet. The Automation screen says so plainly instead of pretending.
- **Protected approval on Windows** (rules / permissions / device changes). Shown
  read-only until a Windows protected boundary is chosen.
- **Subscription CLI Job Object supervisor**, installer integration, code signing.
- **Garage-sale first-photo acceptance task** — depends on the two items above.

## Verification (handoff evidence categories, kept separate)

- Source implemented: yes, for the table above.
- Compiles: yes, zero errors and zero warnings (`dotnet build`).
- Fixture passed: yes — `test\drive.ps1` drove the real `Josi.exe` through Windows UI
  Automation against the mock API: connect, wrong-password error, sign in, open a
  conversation, send a message, thinking indicator, reply, Task Manager, Memory,
  Automation, Vault, Your Settings, Models, Server. No crash.
- Tested against a real Josi CE server: **no** (none is installed on this PC).
- Signed / installed / user workflow accepted: **no**.

## Layout

```
Josi.Windows.csproj  .NET 8 WPF project
tools/New-Icon.ps1   builds the .ico from the approved master
assets/              approved brand masters (copied from the handoff)
src/                 C# source + Theme.xaml + manifest
  JosiApi.cs         HTTP client: cookies + CSRF in memory, no redirects, 4 MB cap, SSE
  AppModel.cs        port of JosiModel.swift
  LocalServer.cs     Josi CE Windows services + UAC operations
  Screens.cs         Welcome, Sign in, Setup
  Workspace.cs       sidebar shell
  Chat.cs, Tasks.cs  conversations, Task Manager
  Sections.cs, Admin.cs  settings sections
  Dialogs.cs, Voice.cs
test/                mock API + UI Automation driver
QUESTIONS.md         open decisions for Roman
```
