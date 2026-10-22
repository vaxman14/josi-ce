# Windows native client: handoff (October 22, 2026)

For the next Claude Code session, on a different Windows PC. Branch:
`windows/native-client-20261020` on `vaxman14/josi-ce`. Read this, then
`docs/WINDOWS_BUILD_LIST.md` (full list and status) and
`docs/WINDOWS_DEV_VOICE.md` (Voice Box on the dev server).

## Working rules from the owner (Roman)

- Ask before pushing to GitHub. Backup branch only: no pull requests, no merges.
- Never type his passwords or vendor credentials. The Claude token is never shown or saved on the PC.
- No Windows services and no administrator changes on the dev machine.
- Build it all, but don't go deep into testing; tell him when something is ready to try.
- Explain in plain words; he tests in the app and the browser.

## State

Working end to end on the old laptop's dev server:

- **Native app (WPF, `apps/windows-native`):** sign-in (password and Google), Claude Code model setup, all sections, chat with images and video.
- **Video and audio:** pinned ffmpeg frames, plus Voice Box Whisper transcripts.
- **Browser control:** the extension (`apps/browser-extension`) uses Josi.exe as its native messaging host and goes through PC Control (`packages/core/src/pcControl.ts`). The assistant has the tools `browser_read_page`, `browser_open_page`, `browser_view_photo` (MCP image content), `browser_click` and `browser_fill`.
- **Memory engine (`packages/agent/src/memoryEngine.ts`):** size-based history with a running thread summary, a summary of the tools each turn used, recall over the owner's own conversations, `search_my_history`, and grounded fact learning after each turn.
- **Self-improvement (`packages/agent/src/improvementEngine.ts`):** insights, then proposals, then super-admin approval. Skills and memory rules are versioned and can be rolled back. The app has an **Improvements** screen and a **What Josi knew** button on each reply.
- **Tests:** `packages/agent/test/memoryEngine.test.ts` (12, all passing).

Not yet tried by Roman in a real chat: the memory engine, the self-improvement loop, the photo fix (`5ad7d6e`).

Pre-existing test failures, also on earlier commits:
- `agent.test.ts`: hop limit, unknown tool.
- `dataTools.test.ts`: MCP catalogue.
- `harness.test.ts` and `subscription.test.ts`: 4 more.

Still open (see the build list):
- Windows Hello approvals (server enrollment is macOS-only).
- Streaming replies.
- Full installer (runtimes, CTranslate2 source build, ffmpeg component).
- Azure signing (needs Roman).
- Google live test.
- Calendar week column clip.
- Chrome profile is shown as "Default" in browser permissions.

## Setting up this machine

Requirements:
- **Software:** Windows 10 or 11, Git, Node.js 24, .NET 8 SDK, Chrome.
- **Disk:** about 15 GB free.

1. Clone into `C:\Dev\josi-ce` and check out the branch. Run `npm ci`, then `npx tsc -b`.
2. **Runtimes in `C:\Dev\josi-dev`.** The simplest way is to copy these folders from the old laptop's `C:\Dev\josi-dev` over the network share: `pgsql`, `python`, `voice-python`, `voice-models`, `ffmpeg`, `cli`.
   - Never copy `data`. It holds the live database and secrets.
   - Or rebuild them: PostgreSQL 16.15 from `packaging/windows/upstream-lock.json`, `scripts/windows/dev/Get-Ffmpeg.ps1`, and Voice Box per `docs/WINDOWS_DEV_VOICE.md`.
3. Create and start the dev server:
   - `powershell -ExecutionPolicy Bypass -File scripts\windows\dev\New-DevServer.ps1`
   - then `scripts\windows\dev\Start-DevServer.ps1`
   - It listens on http://127.0.0.1:8080 and puts PostgreSQL on 15432.
4. Build the app: `dotnet build apps\windows-native -c Release`. Open it **only** with `scripts\windows\dev\Open-DevApp.ps1`, because a directly started Josi.exe can't find the dev server and offers "Set Up on This PC". Its first start registers `josi://`, Send to, and the browser host for Chrome, Brave and Edge (HKCU only).
5. Roman signs in, sets up his Claude model (Models, then "Save and Check Model"; "Tool calling" must pass), and allows his browser in PC Control.
6. Build the extension:
   - `node scripts/unified/build-browser-extensions.mjs <new empty folder>`
   - copy its `chrome` folder to `C:\Dev\josi-dev\browser-extension\chrome`
   - Roman loads it unpacked in Chrome. The extension ID is fixed by `development-identity.json`.

## Gotchas learned the hard way

- **Line endings:** most files are LF, but some (for example `AppModel.cs`) are CRLF. Python's text-mode writes on Windows convert whole files to CRLF. Prefer the Edit tool, and check `git diff --stat` for whole-file churn before committing.
- **`JOSI_MCP_SERVER`:** without it, the Claude Code harness looks for the container path and every tool is switched off. Both `Start-DevServer.ps1` and `Runtime.mjs` set it.
- **Restarting Josi drops the browser tab:** the extension doesn't reconnect, so Roman clicks Attach again.
- **Commits:** use `git commit -F <file>` with `-c user.name=vaxman14 -c user.email=vaxman14@gmail.com`, ending with the Co-Authored-By line.
