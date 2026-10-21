# Questions for Roman — Josi for Windows

Answer whenever convenient. Nothing here blocks the app from building or running; each
item says what I did in the meantime.

## Platform and setup

1. **UI framework.** This PC has no .NET SDK or Visual Studio, so I built on WPF + .NET
   Framework 4.8 (ships with Windows, zero installs). Keep it, or may I install the
   .NET 8 SDK / Visual Studio to move to WPF on modern .NET or WinUI 3?
   *Meanwhile:* WPF on .NET Framework 4.8.

2. **Which machine is the target?** This PC (user `vaxma`) has no Josi CE services and
   no Josi install. The handoff mentions `C:\Users\Roman\...` with native.5 installed.
   Is this a dev machine only, or should it also host a Josi server?
   *Meanwhile:* tested against a local mock API only.

3. **Git.** There's no repository here. Should I clone `vaxman14/josi-ce` at
   `af8b181`, restore the snapshot, and put this app in the monorepo (for example
   `apps/windows-native`) on a new branch?
   *Meanwhile:* standalone folder `JosiWindows\` next to the untouched handoff.

4. **Minimum Windows version.** Windows 10 22H2 and Windows 11? (The app runs on both.)

## Brand

5. **Wordmark dot.** The handoff says "tennis-ball dot on the i", but the current master
   `josi-wordmark.png` (replaced 2026-09-02) has a plain dot, and `build-brand.sh` says
   the tennis-ball dot left with the retired mascot. Which is correct?
   *Meanwhile:* I used the white-J mark plus the "Josi" name, exactly like the Mac app's
   sidebar; the wordmark image is not shown.

6. **Version and naming.** OK to call this build `0.7.0-windows.1`, file publisher
   "SOCAL RECEPTIONIST LLC", product "Josi"?

## Desktop control and Chrome (the big next phase)

7. **Start the executor + Chrome phase now?** It needs: a Windows desktop executor in your
   current session (UI Automation, capture, input, stop-on-your-mouse/keyboard), a Chrome
   native-messaging host, and the extension's attach-a-tab flow. May I begin?
   *Meanwhile:* Automation screen says plainly that control isn't available yet.

8. **Chrome extension distribution.** Load unpacked (developer mode) for testing, or
   publish to the Chrome Web Store? If the Store, which publisher account?

9. **Protected approval on Windows.** For rule / permission / device changes, is
   **Windows Hello with a TPM-backed key** acceptable as the local "a human approved this"
   boundary (the Mac uses Touch ID)?
   *Meanwhile:* Cardinal Rules, permissions and devices are shown **read-only**.

10. **Garage-sale acceptance test** (`romansgaragesale.com/uploads`, first empty
    description, fill, verify, stop). This needs #7 and #9 first. Confirm it's still the
    first real task.

## Installer, signing, updates

11. **One installer.** Fold this app into the existing Inno Setup installer
    (`JosiWindows.iss`) so one installer gives server + app, plus a "remote only" option
    that installs just the app?

12. **Code signing.** Is there a Windows code-signing certificate for SOCAL RECEPTIONIST
    LLC (OV/EV, or Azure Trusted Signing)? Unsigned apps trigger SmartScreen warnings.

13. **Update / Repair.** "Update or Repair Server…" currently asks you to choose the
    Josi CE installer `.exe`. Is there an update feed URL, or should Repair call the
    existing maintenance scripts directly (they run elevated, so I didn't wire them)?

14. **Local setup handoff.** For first-run setup on this PC the app reads the setup token
    from `C:\ProgramData\Josi CE Server\first-run\Open Josi.html` (the installer's
    per-user protected file). Keep that, or change the installer to write a small JSON
    bootstrap like the Mac does?

15. **Local server port.** The installer fixes the public port at `8080`. Confirm.

## Behaviour details

16. **Ctrl+Enter** also sends (Windows equivalent of Cmd+Enter on Mac). OK?

17. **Voice reply audio.** I assumed `/voice/speech` returns WAV (played with the built-in
    Windows player). If it returns MP3/OGG, tell me and I'll add a decoder.

18. **Time zone at setup.** Windows uses its own zone names; I map common ones to IANA
    (e.g. Pacific → `America/Los_Angeles`) and fall back to `UTC`. Should the server
    accept Windows zone names instead, or add a time-zone picker to setup?

19. **Subscription CLIs on Windows.** ChatGPT/Claude subscription sign-in screens are in
    the app, but the server side still needs the Windows Job Object supervisor before
    those run on a Windows server. Should that come before or after the Chrome phase?

---

## Answers (Roman, 2026-10-20)

| # | Answer |
|---|---|
| 1 | Install whatever is best; Roman can help install. |
| 2 | Yes — this PC is the target. |
| 2b | Install a new Josi CE server built from source. |
| 3 | Yes — clone josi-ce at af8b181, restore snapshot, new branch. |
| 4 | Not answered — default: Windows 10 22H2 and Windows 11. |
| 5 | Dot (plain dot on the i, as in the current master). |
| 6 | Yes — `0.7.0-windows.1`, SOCAL RECEPTIONIST LLC, Josi. |
| 7 | Yes — start desktop + Chrome phase. |
| 8 | Load the extension unpacked for testing. |
| 9 | Yes — Windows Hello (TPM-backed) is the protected approval boundary. |
| 10 | Not the garage-sale page; ask Roman for a test page when ready. |
| 11 | Yes for now — one installer with a remote-only option; redesign later. |
| 12 | Azure Trusted Signing exists; tell Roman when ready to sign in. |
| 13 | Repair runs the maintenance scripts directly. |
| 14 | Engineer's choice. |
| 15 | Yes — port 8080. |
| 16 | Yes — Ctrl+Enter also sends. |
| 17 | Engineer's choice — support WAV, MP3 and OGG. |
| 18 | New setting: time zone follows Windows automatically by default, with an option to pin a permanent zone from a list. |
| 19 | Before the Chrome phase. Make sure Claude CLI and Codex CLI are present, with all tools enabled and working. |
