# Handoff to the MacBook: Josi for the Mac mini, all native (November 13, 2026)

Written by the Windows session. Nothing in this list has been built. Roman decided the work
is done on the MacBook, not from the Windows PC.

## The goal

The Linux beta ships as a Docker "all-in-one" image (Josi + Ollama + the Josi model): a 10 GB
download and 23 GB on disk. Roman finds that too heavy, and on a Mac Docker cannot use the GPU.
For a Mac mini with 16 GB the decision is: **no Docker, all native**. The Josi server app for
Mac, plus Ollama installed natively, plus the Josi model pulled from Hugging Face.

Beta testers must be able to install it and send crash reports, the way Linux testers do
(`docs/CRASH_REPORTS.md`, beta.31 and beta.32 in `docs/LINUX_HANDOFF_2026-11-10.md`).

## The Mac mini (checked over ssh on November 13)

- `ssh roman@10.10.1.30`. Apple M4, 16 GB, macOS 27.2, 91 GB free. Sleep is already off.
- No Josi app and no Ollama installed.
- Xcode 27.2 is installed, but `xcode-select` points at the Command Line Tools
  (`sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` before a build there).
- Both Developer ID Application identities are in the keychain.

## Where the branches stand

- Mac head: `origin/redesign/mac-lean-beta` at `a7a47a19` (November 10). It holds all of
  `redesign/windows-lean-beta`.
- It is **86 commits behind** `origin/linux/josi-server` (`d80947d5`). List them with
  `git log --no-merges --oneline origin/redesign/mac-lean-beta..origin/linux/josi-server`.
- The earlier Linux handoff says: do not merge `linux/josi-server` wholesale into a Mac
  branch; port the shared code (apps/api, apps/web, apps/worker, packages/*) and show Roman
  any clash with the Mac look first. Both `0123_*` migrations stay as they are.

## 1. Server features the Mac lacks (shared code on the Linux branch)

- Crash reports and feedback: `packages/core/src/crashReport.ts`, owner routes, the card, the
  first-run choice, the Settings switch, Send feedback, the browser's own crash reporter
  (`89236feb`, `9f54804b`, `ddf8f368`, `a5f5703a`, `3855ece9`).
- Local models: the compact prompt, the Thinking setting (off sends `reasoning_effort` none),
  the context-size error, the request view, OCR for pictures and scans when the model has no
  vision (`e78a6865`, `4d65ff50`, `d56ad489`, `f93abf35`, `814c7133`, `bf808719`).
- Daily Brief and Memory (`cf1351ba`, `7fda3376`, `eb5d0f50`).
- Custom MCP servers and the owner's rule for managed accounts (`04fe89e3`, `f4897d36`).
- The ghost no longer vanishes after a quiet spell (`42f1e1d0`).
- Approvals: a typed yes, an expired request prepared again (`f330bb76`, `852a3b45`,
  `a8ed2f35`, `8fbb68a1`, `c6404898`, `83773765`). Goals follow a re-prepared request (`a27ae73e`).
- Email and sign-in: setup asks Google/Microsoft or SMTP, Sign in with Microsoft, Admin picks
  the sending account (`76a10a07`, `a55611fa`).
- Smaller: Connections search box (`d5ceb8b5`), several accounts per developer service and
  Stripe (`c6c37cdd`), the iPhone server answers (`d168c796`), parental controls round 2
  (`cfe8bc93`, `d26d2284`), the debugger behind a switch (`45fccdef`).

## 2. Mac-only work those features need

- **Tester token.** Josi reads `/etc/josi/tester.json` (or `JOSI_TESTER_FILE`). The Mac runtime
  wipes the environment like Linux does (`packaging/macos/Runtime.mjs` line 33), so an env
  variable never reaches the services. The Mac needs its own token file, set through
  `JOSI_TESTER_FILE` in `Runtime.mjs`, and an installer step or setup field that writes it.
- **Machine facts in a report.** `crashReport.ts` reads `/etc/os-release` and `nvidia-smi`. On
  a Mac that gives "darwin <kernel>" and no GPU. Add the macOS version, the chip and the
  memory (unified, so GPU memory is the RAM). `JOSI_GPU` and `JOSI_VRAM` already override.
- **OCR in the Mac package.** `packages/storage/src/ocr.ts` uses `tesseract.js` and
  `@tesseract.js-data/eng`; they must be in the Mac build's locked inputs
  (`packaging/macos/*.lock.json`).
- **Ollama and the model.** Install Ollama; pull `hf.co/heyjosi/josi:Q4_K_M` (5.8 GB, SHA-256
  `639026e032896869f8176bb6cecaa4c8df14e6ac3a0e31b1aab0e111b43a26cd`); create it as
  `josi-qwen3.5-9b` with `PARAMETER num_ctx 24576`; keep it loaded (`OLLAMA_KEEP_ALIVE=-1`);
  start Ollama at login. In Josi: "A model on your own hardware",
  `http://127.0.0.1:11434/v1`, model `josi-qwen3.5-9b`, Thinking off. Josi's setup should do
  this itself (`docs/JOSI_IS_THE_INTERFACE.md`), so a tester types no addresses.
- **Memory on 16 GB.** Measure with the model loaded and Josi running. `num_ctx` 24576 may
  need to come down. Not measured yet.
- **A tester install path.** The Mac `.pkg` plus the token, and a Mac entry on
  heyjosi.com/beta (the page and its functions are in the josi-app repo, branch
  `site/beta-onboarding`; the sign-up function hands out the Linux `curl` command today).

## 3. Mac app behind the Windows app

Compared by feature switches and file names only, not screen by screen.

- `LocalWorkspace`: on in Windows (`apps/windows-native/src/Flags.cs`), off on the Mac
  (`apps/macos-native/Sources/JosiFlags.swift`).
- `Integrations`: on in Windows, off on the Mac.
- MCP: the Windows app mentions it; the Mac app does not.

## 4. Missing in both native apps (only the web has them)

- The crash report card and Send feedback.
- The Daily Brief page.
- The Thinking setting for a local model.
- `reply_to_message_id` on a sent message, so a typed yes is still refused in the apps.
- A Sign in with Microsoft button (the earlier handoff lists it as not done; the Mac code
  mentions Microsoft, so confirm first). The server side is `GET /api/auth/native/config`
  (`microsoftSignIn`, `nativeMicrosoftStart`) and `/api/auth/microsoft/native/*`.

## 5. Never run on a real second Mac

From `docs/MACOS_CLIENT.md`: the administrator prompt at sign-in, the LAN certificate trust,
Safari in the client, and opening at login. The Mac mini can cover these.

## Order that makes sense

1. Port section 1 to the Mac branch; run the tests.
2. Section 2: token file, machine facts, OCR inputs. Build the server `.pkg`.
3. Install on the Mac mini with Ollama and the model; measure memory; force a crash and see
   the report arrive with a tester token.
4. Sections 3 and 4, in the order Roman picks.
