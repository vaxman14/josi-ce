# Linux handoff for the Mac session (November 9 to 10, 2026)

Branch `linux/josi-server` (worktree "Josi Linux"), pushed, head `7413351` or later.
It already contains the Windows lean beta up to `9cb6123` (merged 2026-11-10, one
conflict, in `pcBrowserTools.ts`). Latest build 1.2.8-beta.10.

## What exists now

**The Linux server** (headless, Debian/Ubuntu and every fork; `curl … | sudo bash`,
interactive with the ghost, or `sudo ./install.sh [--yes]` from a folder):
- Everything the Windows edition does, used from the browser. PC control runs as the
  chosen Linux user in `josi-pc.service` (`packaging/linux/pc-executor/`): commands,
  persistent terminals, files, programs, X11 windows/screenshots/clicks, browser
  extension link. Pairing without a window: spool + one chat card (docs/LINUX_PC_CONTROL.md).
- Josi's own browser for headless machines: Xvfb + pinned Chrome for Testing + the
  extension (`josi-browser.service`).
- Web chat sends durable turns and shows live status, like Windows.
- Docker image of the whole server (`packaging/linux/docker`).
- Release folder installs with no download (`install.sh`, `--from`).

**Sign in for Josi** (docs/LIVE_SIGN_IN.md): Josi's tool `request_sign_in` opens a card;
the person signs in on a live view of her hidden browser or in a terminal running the
exact command shown. Her model never sees the screen, keys or output. Owner only by
default, grants by asking Josi (migration 0123). End-to-end tested on Ubuntu 24.04:
real Chrome received a login typed through the view, a terminal login ran, secrets
appear nowhere on the server (`scripts/linux/e2e-signin.mjs`).

**Shared-code changes the Mac inherits** (all in packages, same as Windows):
- `send_file_to_my_devices` (packages/agent/src/sendFileTools.ts): Josi sends a text
  file she writes to one of the person's OWN devices. The Mac app must register as a
  transfer device and accept `state: accepted` files like Windows (device-transfers).
  `linux` is now a valid device platform.
- Light thinking for ordinary chat: `ChatRequest.reasoningEffort`, Codex gets
  `model_reasoning_effort="low"` unless the turn is a work goal; owner setting
  `chat_reasoning` ("light" default or "model_default"), `PUT /settings-changes/reasoning`.
- Tool registry: every offered tool must be in `ALL_TOOLS`; `toolRegistry.test.ts` checks it.
- `dataTools.test.ts` now starts from switched-off accounts (the Windows change made
  connected accounts start on; the tests assumed off).
- Native host accepts the Chrome Web Store extension id on Linux.

## Done in the last 24 hours (condensed)
Merged Windows twice; fixed the old Linux fix list and review bugs; interactive
installer (asks on the person's own terminal under sudo); domain/HTTPS mode; Josi's own
browser (+ AppArmor profile on Ubuntu 23.10+); web parity (flags, My World, stage cards,
device transfers, account-connection card, focus return); durable-turn live status;
Docker image; folder install; gate (10.10.1.5) wiped and reinstalled, `ce.heyjosi.com`
restored through Cloudflare tunnel `josi-ce` to gate; tested on Debian 13 and Ubuntu
24.04 VMs on claw (10.10.1.3).

## In progress
Web sign-in panel: the live picture showed as a broken image in a real browser (frames
and server are fine); switched to inline images in beta.10, being re-tested.

## Next
1. Re-run `e2e-screens.mjs` against beta.10 (panel must show a real picture), then the
   same on the Debian 13 VM (`e2e-fake`, `e2e-pc`, `e2e-signin`).
2. Upgrade gate to the new build (`sudo ~/josi-install-N/install.sh --yes`).
3. Replace the beta.5 GitHub draft with ONE new draft (owner's choice); nothing public
   until the owner presses Publish.
4. Optional later: a Devices menu badge for waiting files; Wayland live view.

## Checked afterwards: nothing is missing, but Linux is behind Windows (2026-11-10)
Both worktrees ("Josi Linux" and "Josi Windows PC control") are clean and identical to
GitHub: nothing uncommitted, nothing unpushed, no stash. Linux head is `c8d1c2d`.
Do not hunt for lost work on the Mac mini or claw; there is none.

What IS true: Windows `redesign/windows-lean-beta` (head `9b7afc7`) has 6 commits the
Linux branch does not have (after `9cb6123`): `1ede1a5` server: a signed-in person
controls their own PCs; `1e86435` Windows client is a node of whoever signs in;
`0e75cc0`, `8082162` Mac handoffs; `c47e9d0` Forget This PC; `9b7afc7` Safari handoff.
Before the Linux branch takes them, know:
- **Migration numbers (CORRECTION, not a real clash).** Windows adds
  `0123_member_pc_control.sql` (`users.pc_control_allowed`); Linux has
  `0123_live_signin_grants.sql`. `packages/db/migrate.mjs` records the FULL FILE NAME in
  `_migrations`, so both run, in name order, and neither depends on the other. Do NOT
  rename either: gate already ran Linux's, and Windows servers already ran theirs.
  Leave both. (Tidier but riskier: new migrations from now on start at 0124.)
- **Conflicts to expect** in `pcControlRoutes.ts`, `settingsChangeRoutes.ts`,
  `pcPermissionSettings.ts`, `settingsChangeTools.ts`, `pcDesktopTools.ts`: Windows
  moved PC control from owner-only to "any signed-in person allowed
  `pc_control_allowed`", every row keyed by user and PC. Linux local pairing
  (`pcLocalPairing.ts`, spool tickets) and the sign-in routes assume an owner session
  and must follow that rule; sign-in stays owner or granted.
- Safari extension and Mac handoffs are Windows-side docs: `docs/MAC_CATCHUP_HANDOFF.md`,
  `docs/SAFARI_EXTENSION_HANDOFF_2026-11-10.md`.
- For the Mac: do NOT merge `linux/josi-server` wholesale. Port the "Shared-code changes"
  list above; show Roman any conflict with the Mac look first.

## TAKE-OVER PLAN for the Mac (Roman is travelling with it; do all of this)
Goal: Linux branch absorbs the 6 newer Windows commits, builds beta.11, gate upgraded,
draft replaced. Standing rules: commits and pushes to Josi are pre-approved; NEVER open
PRs or merge into main; NEVER publish a release (drafts only, Roman presses Publish);
secrets never through the model; do not upgrade claw's own Josi (1.1.6); commit with
`git -c user.name="Roman Vaxman" -c user.email="roman@Romans-MacBook-Pro.local" -c core.hooksPath=/dev/null -c commit.gpgsign=false`.

**Reachability.** Roman is leaving the house: 10.10.1.x (claw 10.10.1.3, gate 10.10.1.5)
is only reachable on the home network or a VPN. Without it you can still do steps 1-3
(code, unit tests) anywhere. Steps 4-6 need claw/gate; do them when the Mac is back on
the home network, or check whether a VPN/Tailscale route exists. The public address
https://ce.heyjosi.com/ (gate, through the Cloudflare tunnel) works from anywhere, so you
can check gate's health and version there (`/ready`, `/login`) at any time. If you cannot
reach claw, stop after step 3, push, and tell Roman exactly where you stopped.

1. **Get the branch.** `git fetch origin && git checkout linux/josi-server` (head `01b09c2`
   or later). Do NOT merge it into any Mac branch. Work in a worktree of this repo.
2. **Merge Windows into it.** `git merge origin/redesign/windows-lean-beta` (head
   `9b7afc7`, 6 commits after `9cb6123`). Resolve conflicts keeping BOTH sides' intent:
   - Windows rule: PC control routes need a signed-in user allowed
     `users.pc_control_allowed`, not the owner role; every row keyed by user and PC; PC
     permission cards are applied by the person whose PC it is; `POST /identity` accepts
     the password or `elevated:true` on a sign-in under ten minutes old.
   - Linux keeps: local pairing via spool (`packages/core/src/pcLocalExecutors.ts`,
     `apps/api/src/http/pcLocalPairing.ts`), `linux-<32hex>` PC ids, the sign-in routes
     and grants, `send_file_to_my_devices`, light thinking, `ALL_TOOLS` entries
     (`SIGN_IN_TOOLS`, `SEND_FILE_TOOLS`).
   - Files likely to conflict: `apps/api/src/http/pcControlRoutes.ts`,
     `settingsChangeRoutes.ts`, `packages/agent/src/pcPermissionSettings.ts`,
     `settingsChangeTools.ts`, `pcDesktopTools.ts`, `apps/api/test/pcControlRoutes.test.ts`.
   - Linux local pairing writes a ticket carrying an OWNER session; after the merge it
     should be a session for the person who approves the card (they own that PC row).
     Sign-in routes (`liveSignInRoutes.ts`) stay owner-or-granted, unchanged.
   - Windows-only files (`apps/windows-native/**`, `packaging/windows/**`) come along
     untouched; ignore them.
3. **Test (no hardware needed).** `npm ci`, then at least: `npx vitest run` in
   `packages/core`, `packages/agent`, `apps/api` (needs the test database the repo
   already uses), `apps/web`; plus `toolRegistry.test.ts`, `pcDesktopLinux.test.ts`,
   `apps/api/test/liveSignIn.test.ts`, `pcControlRoutes.test.ts`. Known unrelated
   failures from the Windows handoff: ~32 connector tests, 3 API storage tests,
   `immediateRetry`; dataTools failures are NOT pre-existing on Linux. Commit and push.
4. **Build beta.11 on claw** (`roman@10.10.1.3`, source in `~/josi-linux/src`): copy the
   tree there, then `DOCKER_CONFIG=~/josi-linux/docker-anon scripts/linux/build-release.sh
   --version 1.2.8-beta.11 --skip-provision` (Docker Hub login fails on claw; the anonymous
   config is the fix). Output: the release folder with `.deb`, Arch pkg, `linux` installer,
   `install.sh`, `SHA256SUMS.txt`.
5. **Test on the VMs** (via claw): `josi-debian13-vm` (ssh -p 2223) and
   `josi-ubuntu2404-vm` (-p 2224). Install the build, then run `scripts/linux/e2e-fake.mjs`,
   `e2e-pc.mjs` (9 steps), `e2e-signin.mjs` (5 steps), `e2e-screens.mjs`. All must pass.
6. **Gate (10.10.1.5)**: copy the release folder to `~/josi-install-11` and run
   `sudo ./install.sh --yes` (keeps data; one sudo prompt). Check `https://ce.heyjosi.com/`
   reports `1.2.8-beta.11`, services `josi josi-pc josi-browser cloudflared` active.
7. **GitHub draft**: replace the beta.10 draft with ONE new draft `v1.2.8-beta.11`
   (pre-release, draft). Never publish. Draft URL for beta.10 is under
   github.com/vaxman14/josi-ce/releases (untagged-3337c85b00f38f60ede1).
8. **Report to Roman**: what merged, what conflicted and how you resolved it, test
   results with failures named, and the HQ block.

Still untested with the REAL model on gate (only the fake model so far): sign-in cards
and `send me that report`. Ask Roman to try them when he is on gate.

## Added on the Mac, 2026-11-10: email through an account, Microsoft sign-in
Asked for by Roman after the take-over. All shared code (packages and apps/web), so
Windows and the Mac inherit it when they merge this branch's packages.

- **Setup's email step is a question first.** Two cards: "Google or Microsoft account"
  or "SMTP server", plus Skip. Each form stays hidden until its card is chosen
  (`EmailStep` in apps/web/src/pages/Setup.tsx). With no public HTTPS address the
  account card is shown but off, with the reason under it.
- **The account way, inside setup:** save the provider's client ID and secret
  (`PUT /api/setup/mail-account/client/:provider`, checked with the provider), connect
  the owner's account (`POST /api/setup/mail-account/start`; the provider returns to the
  ordinary `/api/connections/:provider/callback`, which setupGate lets through and
  connectorRoutes finishes for a handshake setup itself started, with no session), then
  `POST /api/setup/steps/smtp` with `{account:{provider,fromName},testTo}` sends a real
  test message. Two redirect addresses are shown to register: `/api/connections/<p>/callback`
  and `/api/auth/<p>/callback`.
- **Josi's own email through that account** (sign-in codes, password resets, notices to
  the owner): `packages/connectors/src/systemMail.ts`, table `system_mail_account`
  (migration 0124). `accountMailSender()` is tried first everywhere system mail is sent;
  the SMTP system profile is the other way. Saving an SMTP server (setup or Admin)
  switches back to SMTP. Gmail API `messages/send`, Graph `me/sendMail`, text only.
- **Sign in with Google** needs nothing more: it works once the Google keys exist and the
  person's Google account is connected, which the step above does for the owner.
- **Sign in with Microsoft is new**: `/api/auth/microsoft/start` and
  `/callback`, same rules as Google (state held by the starting browser, PKCE, the
  person's own connected Microsoft account, authenticator still asked). States carry
  their provider (`auth_oauth_states.provider`). `/api/auth/methods` now says `google`
  and `microsoft`; the login page hides either button when its keys are missing.
  For the native apps (asked for by the iPhone session, build 32): `GET /api/auth/native/config`
  adds `microsoftSignIn` and `nativeMicrosoftStart`; `GET /api/auth/microsoft/native/start`
  takes `return_uri` or `redirect_uri` (`josi://auth/callback` only); `POST
  /api/auth/microsoft/native/exchange {code}` answers like Google's.
- **Not done:** an Admin screen to pick or change the sending account after setup (today:
  redo it by saving SMTP, or in setup); a Microsoft button in the Windows and Mac apps
  (the server side is ready); HTML or attachments through the account sender.
- **Needs a real try on gate:** a real Google and a real Microsoft app (only fake
  providers so far). Tests: `setup.test.ts` ("email through a Google or Microsoft
  account"), `microsoftSignIn.test.ts`, `packages/connectors/test/systemMail.test.ts`.

## State at the end of the Mac session (2026-11-10, about 15:20 PST)
- Take-over plan done: Windows merged (`2531f4c`, one conflict in `pcPermissionSettings.ts`;
  the server's own executor stays owner-only in `pairLocalExecutor`), unit tests equal to
  the pre-merge baseline (22 old failures, none new), beta.11 built on claw from `76a10a0`.
- VMs: Debian 13 fresh install and Ubuntu 24.04 upgrade from beta.10, both `e2e-fake`,
  `e2e-pc`, `e2e-signin` all PASS. `e2e-screens` was NOT run (no Playwright on the VMs);
  the setup email step was checked with Playwright against a preview server on claw.
- GitHub: ONE draft pre-release `v1.2.8-beta.11` (target `76a10a0`); the beta.10 draft is deleted.
- **Gate was wiped on Roman's order**, not upgraded: no Josi package, data, accounts or
  folders. Only the Cloudflare tunnel stays (`ce.heyjosi.com` -> 127.0.0.1:8080). Roman
  installs it himself, as a user would: `curl -fsSL http://10.10.1.3:18099/linux | sudo bash`
  (claw serves `~/josi-linux/lan` with `python3 -m http.server 18099`; start it again after a
  claw reboot). Answer "my own proxy", public address `https://ce.heyjosi.com`, port 8080.
- `ec9fa84` (client ID wording in setup) is on the branch but not in the beta.11 build.
- **Installer fix after Roman's first try on gate** (`281f7e3`): under sudo-rs (Ubuntu 25.10+,
  gate is 26.04) typed answers lost letters or Enter, because sudo-rs relays the keyboard
  into its own terminal while the installer also read the outer one. Now under sudo-rs
  the installer becomes the foreground group of its own terminal and reads there; classic
  sudo is unchanged. Checked by typing through a real pty on gate, Debian 13 and Ubuntu
  24.04. The `linux` file was re-rendered (packages unchanged) in the release folder, on
  claw's LAN server and in the GitHub draft. The VM e2e runs use `--yes`, so they never
  type; a typed-answers check belongs in the test list.

## beta.12 (2026-11-10 evening): what Roman found using beta.11 on gate
- Gate was installed by Roman with the one-line command, set up with a real Google
  account (keys, connect, test message) and is in use. Google sign-in is live there.
- **Email approval in the web chat had no reachable buttons.** The stage clipped a tall
  reply plus card at both ends with no scroll. Now: with an approval on the stage the ghost
  is smaller, the card shrinks to the room left and its text scrolls inside it, the reply
  that only repeats the card is not shown, and the stage scrolls as a last resort
  (`Talk.tsx`, `.stage-with-card` in index.css). Checked with Playwright at 1000x505,
  1280x720 and 390x760: Approve is fully above the message bar in all three.
- **A typed "approved" did nothing.** The web chat never sent `reply_to_message_id`, which
  the server requires of durable clients, and "approved" was not an accepted word. The
  web now sends the id of Josi's message on screen; YES also takes approved, go ahead,
  I approve; NO takes denied, decline, don't send it (`packages/core/src/actionState.ts`).
  Not tried end to end with a worker; the server rule is unit-tested. Windows, Mac and
  iPhone still do not send `reply_to_message_id`, so a typed yes there is still refused.
- Built from `a8ed2f3`; Ubuntu 24.04 VM upgraded beta.11 -> beta.12, all three e2e scripts
  PASS. claw's LAN install address serves beta.12; rerunning the install command upgrades.
- **Installer update path** (`c15de66`, asked for by Roman after the upgrade showed every
  install question again): on a machine that already has Josi, with no flags, the installer
  says which version is here and which it becomes, shows the saved settings and asks one
  question (go ahead, or change the settings first). Typed through a pty on the Ubuntu VM:
  both answers work, repair ends with Josi running. Installer re-rendered for beta.12
  (release folder, claw's LAN address, GitHub draft); packages unchanged. GitHub now has
  ONE draft, `v1.2.8-beta.12`; the beta.11 draft is deleted.
- Still open from Roman's run: the installer's doubled ghost (LINUX_FIX_LIST.md); the web
  card says "Not now", Josi's text says "Approve or Deny".

## beta.13 (2026-11-10 late): more from Roman's use of gate
- **An expired approval left nothing to press** (`8fbb68a`). Approvals last 15 minutes
  (`prepareAction`, ttl 900). Asked for the card again later, `draft_email` answered
  "already prepared and waiting" for a request that had expired: no card on the stage, no
  button on Approvals or the task, while Josi said "use the control below". The same draft
  is now prepared afresh (old state `expired`, old task cancelled, new approval). Test in
  `packages/agent/test/actionState.test.ts`. Still true: when an approval expires the
  stage card just disappears and Josi's last message still points at it; and 15 minutes
  may be short for a person. Roman has not decided either.
- **Installer screen under sudo-rs** (`efcaba8`): the terminal the person types in stayed
  in its normal mode (echo, line at a time), so every answer was printed twice and moved
  the screen a row more than counted: old questions stayed, the header ghost was left
  behind, the progress ghost was drawn through it. That terminal is now set to pass keys
  straight on, unechoed, while the questions are asked (`quiet_outer`), and restored after
  them and at exit. Checked on gate at 99x30 with a do-nothing copy of the installer and
  a small terminal model: clean at every prompt and at the end, terminal mode restored.
- **The ghost thinks** (asked for by Roman: a thought bubble, sarcastic, different every
  time): `Q_ASK`, `Q_UPD`, `Q_0`..`Q_5`, `Q_DONE`, `Q_FAIL` in the installer; `think` picks
  one at random that fits the width, never the same twice running, a new one per step and
  every seven seconds. Only with the ghost (UTF-8, 72+ columns, 24+ rows).
- Built from `efcaba8`; Ubuntu 24.04 VM upgraded beta.12 -> beta.13, three e2e scripts PASS.
  claw's LAN address serves beta.13.
- Two idle `sudo bash` installer processes from my earlier typing tests (started
  23:18 UTC) are still on gate; I was not permitted to stop them. They are harmless.

## beta.14 (2026-11-10, 16:50 PST): the expired approval, properly this time
- beta.13's fix was not enough on gate. Gate's own records (times UTC): approval created
  23:34, expired 23:49; the action state stayed `prepared` but `presented_turn_id` was
  null, because ANY later outbound message clears it (`conversations.ts` line 100). So
  "send it now" found no presented candidate, was not an approval phrase either, and went
  to the model, which answered "use the Approve control on the card above" with no tool
  call and no card anywhere.
- Now (`c640489`, `packages/core/src/actionState.ts`): the newest request in the
  conversation (within a day), if expired, is prepared again when the person agrees in
  words that name the act (send, approve) or answer the message that showed it. New task,
  new approval, new card; nothing is sent on the stale yes; a bare yes after an unrelated
  message stays ordinary talk. More phrases count as yes ("send it now", "go ahead and
  send it", "yes, send it", "approve it"), from one list (`isActionDecision`) shared with
  the durable-turn check in assistantAgent.ts, which had its own stale copy. The system
  prompt tells the model never to point at a card from memory and to call the draft tool
  again instead.
- Built from `c640489`; Ubuntu VM upgraded beta.13 -> beta.14, three e2e scripts PASS;
  claw serves beta.14; GitHub draft swapped to beta.14.
- Reading gate's database: user `josi`, db `josi`, 127.0.0.1:15432, password file under
  `/var/lib/josi/data/secrets/*/database-password` (root). Query status columns only.

## beta.15 and beta.16 (2026-11-10 evening)

- **beta.15**: Josi's built-in debugger, step one (docs/JOSI_DEBUGGER_PLAN.md). Switch
  `DEBUGGER_BUILT_IN` in `packages/core/src/debugger.ts` is `true`; **set it to `false` before release.**
- **beta.16**: everything the iPhone app asked the server for (docs/IOS_SERVER_ANSWERS_2026-11-10.md
  has the exact shapes): push straight to Apple (`packages/core/src/apns.ts`, key pasted in Admin,
  Overview, "iPhone notifications"), Sign in with Apple on by default, short spoken replies
  (`reply_style: "spoken_short"` on a turn), two-way reminder sync, App Store Connect and Google Play
  as connectable services (every service now lists `fields`), and parental additions (rules
  endpoint, blocked topics and apps, ask-for-more-time with a push to the parent). Migrations 0126 to 0130.
- Known gaps from that work: the web Family page is still a "Coming Soon" stub; no second parent,
  invites or spending limits; Apple sign-in revocation on account deletion is not built; overdue
  phone reminders are refused; a push with no Apple key retries a few minutes and is then dropped;
  nothing was tried against real Apple or Google keys; every server needs Roman's own Apple push
  key to notify the Josi iPhone app, so other people's servers cannot notify it yet.

## beta.17 (2026-11-10, 22:37 PST)

Commits `cfe8bc9` and `c6c37cd`. Built on claw (build-19.log). Upgrade from beta.16 passed all three
e2e scripts on the Ubuntu VM and the Debian VM. Claw's LAN installer serves beta.17. GitHub has one
unpublished draft, `v1.2.8-beta.17` (9 files); the beta.16 draft is deleted. Gate is still on beta.14.

- Parental controls round 2 (section 8 of the iPhone note): `device` object, setup window,
  `device-events`, `device-activity`, `family_requests` tool. Migration 0131. The web Family and
  Parental controls pages are the real ones now (flags on, "Coming Soon" stubs removed).
- `scripts/linux/build-release.sh` stamps `publisher/licence-verification-key.b64` before `tsc` and
  puts `buildStamp.ts` back afterwards. Before this a Linux build refused every licence.
- Several accounts per developer service: `developer_connections.account_key` and `nickname`
  (migration 0132), Vault slot `token` for the first account and `token.<key>` for the rest.
  `loadDeveloperCredentials` refuses with the list of accounts when several exist and none is named;
  the debugger passes `first: true`.
- Stripe is a service. Google Play: `packageName` optional (comma list), apps listed from the Play
  Developer Reporting API when it is enabled. Supabase is named by organization.
- Not decided: how a customer gets the parental controls licence (included, sold, or always on).
- Not tried against the real services: Stripe, Google Play app list, anything Apple.
- Custom MCP connections are being built next (owner's choices: each person their own, remote only,
  token or OAuth, read-only tools run, everything else asks). Migration 0133. Not in beta.17.
- OAuth for the developer services was researched, not built. Device flow makes GitHub and GitLab
  easy; Railway and Linear are simple; Supabase, Notion, Netlify, Sentry, Jira, Cloudflare and Google
  Play need a fixed callback (a hosted relay page, or each install registers its own app); Vercel
  and Neon are not open; Render, Docker Hub, npm and App Store Connect are key only.

## beta.18 (2026-11-10, 23:55 PST)

Commits `d26d228` (parental always on) and `04fe89e` (custom MCP, lookup fix). Built on claw
(build-20.log). Upgrade from beta.17 passed all three e2e scripts on the Ubuntu and Debian VMs.
Claw's LAN installer serves beta.18. GitHub has one unpublished draft, `v1.2.8-beta.18` (9 files);
the beta.17 draft is deleted. Gate is still on beta.14.

- Parental controls are always on: `includedModules` in `packages/core/src/entitlements.ts`. The
  owner may make it paid again; that is removing the module from that list. Licence code unchanged.
- Custom MCP (owner's choices: each person their own, remote https only, none/token/header/OAuth,
  read-only tools run and everything else waits on the Approvals page). Migration 0133,
  `packages/connectors/src/mcp*.ts`, `packages/agent/src/mcpTools.ts`,
  `apps/api/src/http/mcpRoutes.ts`, `docs/CUSTOM_MCP.md`. Built by a subagent, reviewed here.
- Found by trying real servers: `pinnedLookup` (customApiRequest.ts). The socket lookup answered
  Node's `all: true` question with one address, so every real outbound request from Custom APIs,
  workflows and MCP failed with "Invalid IP address". The suites inject fetch and never saw it.
- Tried for real from this Mac: connect and list tools on two public MCP servers with no sign-in;
  sign-in discovery on Supabase, Stripe, Notion, Linear and Netlify MCP (all offer registration).
- NOT tried: a full browser sign-in to an MCP server, a tool call that needs approval against a real
  server, the web screens in a browser, a real Custom API call after the lookup fix.
- Open questions for the owner: a managed child account can add MCP servers when the policy is
  "everyone"; MCP approvals are on the Approvals page (no card in chat); the iPhone gets an approval
  push whose id is an MCP pending id.
- `vmtest.sh` waits: `pgrep -f "[v]mtest.sh"` matches a stale idle bash (pid 2634591) on claw, so
  wait on the "== ALL DONE" line in the log instead.

## beta.19 (2026-11-11, 01:43 PST)

Commit `f4897d3`. Built on claw (build-21.log). Full suite: no new failures. Upgrade from beta.18
passed all three e2e scripts on both VMs. LAN installer and the one GitHub draft are beta.19; the
beta.18 draft is deleted. Gate was on beta.16 when last looked.

- The Ubuntu VM's first upgrade failed with a full disk: every old version stays in
  `/var/lib/josi/versions` (fix list: "old versions pile up"). Cleared beta.4 to beta.15 by hand on
  that VM; it then passed. The Debian VM is at 47%. Gate has 1.8T free.

## beta.20 (2026-11-11, 02:20 PST)

Commit `d5ceb8b`: the Connections page is a search box. Connected things show collapsed; the rest
appear when their name is typed or "Show all services" is pressed. Looked at in Chrome against the
Ubuntu VM (vite on localhost:8080 proxied to the VM, signed in with the VM's e2e account).
LAN installer and the one GitHub draft are beta.20. Both VMs pass all three e2e scripts.

- The first VM run looked like a failure: `vmtest.sh` was started twice per VM about 27 seconds
  apart and the two runs collided ("another Josi install or update is still running", then
  ECONNREFUSED while the service restarted). Cause not found; leftover wait loops from earlier
  builds were still alive on claw and were killed. A single clean run passed. Before starting
  vmtest, check `ps -eo pid,cmd | grep "[v]mtest"` is empty, and wait on "== ALL DONE" in the log.

## beta.20 and the Docker image (2026-11-11, 02:19 PST)

Commit `d5ceb8b` (Connections page: search box, everything collapsed; checked in Chrome against the
Ubuntu VM). Built on claw (build-22.log). Both VMs upgraded and passed all three e2e scripts. LAN
installer serves beta.20.

- Docker: `packaging/linux/docker` (Debian 13 + systemd + the same .deb). Image `josi:1.2.8-beta.20`
  built on claw from the beta.20 package; all three e2e scripts pass inside the container.
  Packed as `~/josi-linux/lan/josi-docker-1.2.8-beta.20.tar.gz` (1.8 GB) with a starter served at
  `http://10.10.1.3:18099/docker` (`curl -fsSL … | sudo bash`; `JOSI_PORT`, `JOSI_NAME`,
  `JOSI_HOST_ADDRESS`). A fresh one runs on claw as `josi-docker` at `http://10.10.1.3:18095`.
- A systemd container has no console without `docker run -t`, so `docker logs` is empty and the
  setup link is only in the journal (`docker exec <name> journalctl -u josi-firstboot -o cat`).
  README, compose file and starter all use a terminal now (commits `767cd92`, `1a895fa`).
- The image is not built by `build-release.sh` and is not on any registry.
- GitHub has TWO `v1.2.8-beta.20` drafts (ids 441537589 and 441539939, same commit, 9 files each);
  the first appeared two minutes before this session made the second. Deleting one was refused by
  the permission check, so the owner has to delete one by hand.
- Do not wait with `pgrep -f` on a pattern that also appears later in the same command line; it
  matches itself. Use a marker file.

## beta.21 and beta.22 (2026-11-11 afternoon): arm64, for a Raspberry Pi

The owner asked for an arm64 version for a Pi. beta.21 was built and never handed out (its arm64
package did not start on a Pi 4); beta.22 is the one.

- **Build.** `build-release.sh --arm64` makes the arm64 packages after the Intel ones. The
  compiled parts (PostgreSQL, the setup helper, the voice packages) are built once in an arm64
  Debian 12 image under emulation on claw and kept in `<build base>-aarch64`; staging and
  packaging run on claw itself with `JOSI_LINUX_ARCH=aarch64`. Details in
  `docs/LINUX_BUILD_ON_CLAW.md`.
- **Passwords.** `@node-rs/argon2`'s Linux arm64 file dies with an illegal instruction on a Pi 4
  when it is loaded, which killed the web server and the worker. Linux arm64 now uses Node's own
  argon2 (`packages/auth/src/passwords.ts`); every other platform is unchanged. Same stored
  format; `passwordEngines.test.ts` checks each accepts the other's hashes.
- **Josi's browser.** There is no Chrome for Testing for Linux on ARM, so there
  `josi-browser.mjs` links the system's Chromium where the pinned Chrome would be, and the
  installer adds the `chromium` package on ARM.
- **Docker.** `packaging/linux/docker/Dockerfile` takes the package named for `TARGETARCH`
  (amd64 or arm64) and adds `chromium` on arm64. An arm64 image has not been built.
- **Tested.** Intel: Ubuntu 24.04 and Debian 13 VMs, upgrade, all three e2e sets pass. Pi 4
  (8 GB, Debian 13, `roman@10.10.1.195`, key `~/.ssh/id_ed25519_josi_pi`, passwordless sudo):
  fresh install, all services up, `e2e-signin` 5/5, `e2e-pc` 8/9 (the miss was the test asking
  for a window named Chrome; fixed in the test afterwards, not rerun), `e2e-fake` 4/5.
- **Open: Codex on the Pi gets no Josi tools.** `e2e-fake` step 5: Claude Code passes, Codex
  runs but the model is offered 3 tools instead of 6 and never calls one. Codex does start the
  tool server and list its tools on the Pi (seen with a stand-in server), and Josi's server
  loads in 2.4 s there, so it is not the 10 s start limit. Not found yet. Intel is fine.
- **Not tried on ARM:** an upgrade, voice (speech in and out), a real model, a Pi 5, Ubuntu or
  Raspberry Pi OS (only Debian 13), the Arch arm64 package, the Docker image.
- The Pi was left with a clean beta.22 install for the owner to set up.

## beta.23 (2026-11-11, 16:40 PST): Codex gets Josi's tools on a slow machine

- **Cause of the open item above.** Codex 0.152 sends its first request to the model without
  waiting for a tool server that is still starting; a late server is silently left out. Josi's
  server takes over two seconds to load on a Pi 4. Shown on the Pi with a stand-in tool server
  and the fake model: instant server, 9 tools; 4 seconds late, 6 tools.
- **Fix.** `codexArgs` (`packages/llm/src/providers/codexCli.ts`) adds
  `mcp_servers.josi.required=true` and `startup_timeout_sec=60`. Codex then waits (seen with a
  server 20 seconds late). A tool server that cannot start now fails the turn.
- **Tested.** Intel VMs (upgrade) and the Pi 4 (wiped, fresh install): all three e2e sets pass on
  each, `e2e-fake` 5/5 and `e2e-pc` 9/9 on the Pi.
- The owner said the Pi may be wiped at will. It was left with a clean beta.23 install.
- Still not tried on ARM: an upgrade, voice, a real model, a Pi 5, Ubuntu or Raspberry Pi OS,
  the Arch arm64 package.

## beta.22 Docker images, amd64 and arm64 (2026-11-11, 15:00 PST)

Built on claw from the two beta.22 packages, one Dockerfile (`--platform linux/amd64` and `linux/arm64`):
`josi:1.2.8-beta.22-amd64` and `josi:1.2.8-beta.22-arm64`. Packed in `~/josi-linux/lan` as
`josi-docker-1.2.8-beta.22-<arch>.tar.gz`; the starter `http://10.10.1.3:18099/docker` picks by `uname -m`.
Build folder `~/josi-linux/dockerbuild22`, scripts `~/josi-linux/dbuild22.sh` and `dsmoke22.sh`.

- amd64: started on claw, all services up, setup link printed. The e2e scripts were not rerun on beta.22.
- arm64: proven on the Raspberry Pi (2026-11-11, 16:20 PST). Docker there is Debian's own
  (`docker.io` plus `docker-cli`; without recommends the command is a separate package). The starter
  downloaded and loaded the image (about 9 minutes on the SD card) and every service came up.
  e2e inside the container: `e2e-pc` 9/9, `e2e-signin` 5/5, `e2e-fake` 4/5. The one miss is the known
  Codex-on-ARM tools problem (same as the native package), not a Docker matter. The native Josi on
  port 8080 kept running throughout. A clean container `josi-docker` is left on the Pi at port 8090
  (volumes `josi-docker-*`). Under emulation on claw the same image cannot start its services
  (`status=226/NAMESPACE`, systemd sandboxing under qemu); ignore that.
- Bug found and fixed in the Dockerfile: the container is privileged, and its `systemd-binfmt.service`
  cleared the HOST's binfmt list, which switched off ARM emulation on claw the moment an amd64 Josi
  container started. The service and the binfmt mounts are now masked in the image. Images built before
  this (the running `josi-docker` beta.20 container on port 18095) still do it: restarting that container
  clears emulation on claw again; bring it back with `docker run --privileged --rm tonistiigi/binfmt --install arm64`.
- The GitHub draft does not carry the Docker images.

## beta.24 (2026-11-12, 15:45 PST): thinking off for local models, Docker reaches the host

Built by the Docker session (commit `e78a6865`, `build-26.log`), 13 files, both processors.

- New: "A model on your own hardware" has a `thinking` setting (a picker; the catalogue field has
  `choices`). `off` makes `openaiCompatible.ts` send `reasoning_effort: "none"`. Only for
  `openai_compatible`, only when chosen. Roman's own model (Qwen, on Ollama at 10.10.1.239) returns
  empty replies after tool results with thinking on (the model builder measured 9/93 against 89/93).
- Docker: run line, compose file and the LAN starter add `host.docker.internal:host-gateway`.
- Tried: the llm and setup suites (331 pass; the full suite was not run). VM upgrades: Ubuntu all
  three e2e pass; Debian fake and pc pass, signin 4/5 on the first run ("the site received nothing"
  on the typed login), then 5/5 twice on rerun, so a flake, not chased. Ollama 0.32.6 on claw
  accepts `reasoning_effort: "none"` on `/v1/chat/completions`. The amd64 image starts, has the
  setting in its catalogue, and its web service user can reach a server on the Docker host by
  `host.docker.internal`.
- Not tried: the setting against a thinking model, the picker in a browser, the arm64 beta.24 image
  on the Pi (the Pi container is still beta.22).
- LAN installer and Docker starter (`http://10.10.1.3:18099/linux` and `/docker`) serve beta.24.
  Images: `josi-docker-1.2.8-beta.24-<arch>.tar.gz`. GitHub draft swapped to v1.2.8-beta.24 (12 files).
- Roman deploys the Docker container on 10.10.1.239 himself. Do not touch that machine.
- `vmtest.sh` now points at beta.24. Next version is beta.25, next log `build-27.log`.

## beta.29 (2026-11-12, about 20:15 PST): small local models (compact prompt, OCR, context, speed)

Written by the session that did the Docker image and the Thinking setting (beta.22 to beta.24).
Asked for by Roman for his own model on the machine he calls docker (10.10.1.239, Ollama,
`josi-qwen3.5-9b`, no vision, 8 GB GPU). **He deploys there himself. Do not touch that machine.**
beta.26, beta.27 and beta.28 were built and tested on the way and never drafted; beta.29 is the one.

What changed, all for provider "A model on your own hardware" (`openai_compatible`) unless said:

- **Prompt size** (new setting, `provider_config.prompt`: auto, compact, full). Compact
  (`packages/agent/src/compactPrompt.ts`): a fixed instruction text (`COMPACT_CORE`, about 390
  tokens with the authority note), only the tools the message's words point at
  (`selectCompactTools`, word groups, tool order kept, descriptions shortened), recent history
  only (`compactHistory`, dropped in blocks of six). Everything that changes between requests
  (time, memories, recall, My World, notes, guidance, saved work) goes in a block at the END of
  the person's message (`contextTail`), so the start of the request is the same bytes every time.
  Auto = compact when the model server reports under 32,000 tokens of context, or does not say.
  Plain conversation is offered no tools. A follow-up whose own words point nowhere takes the
  tools of the person's previous message; Josi's replies never pick tools. A reply that repeats
  the context note is cut where the echo begins. A message with an attachment is answered from the
  attached text: only its own words pick tools and the file-search group is left out. A message
  that names a tool outright gets that tool (the VM tests rely on this).
- **Context**: `packages/llm/src/contextDetect.ts` asks the server (Ollama `/api/ps` then
  `/api/show`, llama.cpp `/props`, the model list), keeps the answer in `workspace.settings.modelContext`
  for ten minutes, refreshed at a model test and at a turn. A request the server turns down for
  size becomes `LlmError` category `context_overflow` with both numbers (`contextOverflow` in
  `openaiCompatible.ts` reads them; only numbers are taken from the server's sentence), the turn
  fails with code `context_overflow`, and the worker also writes the sentence into the
  conversation. A request estimated at more than 115% of a known context is not sent.
- **Sizes**: `packages/llm/src/promptSize.ts` estimates system, tools, history and message
  (characters over 4, tool JSON over 3.4) and scales to the server's own count when that count is
  not a cache-shortened one. Logged per request (`josi-ce: model request N of this message …`),
  the last one kept in `workspace.settings.lastPrompt`.
- **Models page**, new card "Size and speed": context and where it came from, prompt in use, last
  request split four ways with a warning when it does not fit, background requests on or off,
  recent requests from `llm_usage` (why, tokens in and out, seconds, tokens a second;
  `GET /api/admin/llm/requests`), and the state of the debug log.
- **Thinking** is off unless set to "Leave it to the model" (was: on unless set off). A server
  that answers 400 or 422 to `reasoning_effort: "none"` is asked again without it, and that
  client stops sending it.
- **OCR** (`packages/storage/src/ocr.ts`, `packages/agent/src/attachmentText.ts`): pictures for a
  model without image understanding, and PDFs with no text layer for every model, are read with
  the Tesseract WebAssembly build and English data already in the package (nothing new is
  installed, nothing leaves the server). Text comes back per page with a confidence figure and a
  POOR mark under 60%; first 12 pages of a scan. Kept on the attachment (`analysis_code`
  `ocr_text`). The reply is prefixed by the server with "I read the text in this image…".
  Attached text over a local model's budget (12,000 characters under 32,000 tokens of context) is
  condensed in up to six parts, one model call each (`purpose` `attachment.condense`).
- **Five-part test**: the image step of a model without vision reports "Not supported by this
  model. Josi uses OCR instead…" with `substitute: 'ocr'`; the web no longer lists image
  understanding under unavailable features. The API still returns `chat_vision` in
  `disabledFeatures`, with the new sentence, for the native apps.
- **Background learning** (`provider_config.background`, default off for a local model): the
  worker skips `memory.learn` and `improvement.review`. The conversation summary still runs.
- **Debug log**: `sudo touch /etc/josi/llm-debug` (no restart) writes every chat-completions
  request body and raw reply to `/var/lib/josi/data/logs/<web|worker>/llm-debug/model-calls.jsonl`
  (0600, rolls at 50 MB). An environment variable would not work: `Runtime.mjs` clears the
  environment. Only the OpenAI-shaped adapter writes it; the subscription CLIs do not.
- **Docker**: `JOSI_PUBLIC_URL=https://name` makes firstboot use `--address-mode proxy
  --public-url` and print the setup link at that name. Without it nothing changes.

Tested:
- Mac: typecheck clean; full suite 22 failures, the same 22 as the baseline (run on the commit
  before the last three small ones; agent and model suites rerun after each).
- VMs: beta.27 Ubuntu upgrade and Debian FRESH install, beta.28 both upgrades: e2e-fake, e2e-pc
  9/9, e2e-signin 5/5 each time. beta.29 results are in the last lines of this section. The Debian VM had been left by the typed-installer test on port 8099
  without a browser, which fails e2e-pc and e2e-signin on an upgrade; `fresh` puts it back.
- The fake model in `scripts/linux/e2e-fake-model.mjs` now sets aside the context block.
- A real local model: the amd64 image on claw (container `josi29`, port 18096) against
  claw's own Ollama 0.32.6, `llama3.2:3b`, through a small forwarder on the Docker bridge
  (`~/josi-linux/dreal29.sh`; Ollama itself was not changed). Context detected 4,096 (loaded),
  compact prompt chosen, greeting 536 tokens in one request, reminder set through the tool in two
  requests, picture and two-page scanned PDF read at 89% and 92% confidence, the full prompt
  (about 20,000 tokens there) turned down with both numbers and not sent.

Not tried: Roman's own model and Ollama 0.40; a thinking model; the Models card and the Prompt
size picker in a browser; a turn through the worker with an attachment (the trial used the direct
`/talk` route; the worker has the same calls); the long-attachment condensing against a real
model; JOSI_PUBLIC_URL behind a real tunnel; the arm64 image of this build.

Known gaps, told to Roman: OCR is English only; behind a tunnel every visitor has one IP (Caddy
replaces X-Forwarded-For and `CF-Connecting-IP` is not read), so the sign-in limit of 25 tries per
15 minutes is shared; no judge role, no per-turn training capture and no JSONL export exist.

beta.29 results (build-31.log, 13 files, built from `bf808719`): Ubuntu and Debian VM upgrades all
pass (e2e-fake, e2e-pc 9/9, e2e-signin 5/5). In the amd64 image against `llama3.2:3b`: greeting one
request of 444 tokens, the invoice picture and the two-page scanned PDF answered correctly from
OCR with the server's "I read the text…" line, full prompt refused with both numbers. That 3B model
is unreliable at calling tools: across four runs the reminder was set once, and once the call came
back as text. `JOSI_PUBLIC_URL` tried in a throwaway container: proxy mode, setup link printed at
the https name, kept after a restart, cookies Secure. LAN folder and Docker starter serve beta.29
(`josi-docker-1.2.8-beta.29-<arch>.tar.gz`); GitHub draft is v1.2.8-beta.29 (12 files), the
beta.25 draft is deleted. The trial containers and the Ollama forwarder on claw are removed; the
old `josi-docker` beta.20 container on port 18095 is still there.

Next version is beta.30, next log `build-32.log`.

## In beta.19 (was: after beta.18)

- Managed child accounts cannot add or use MCP servers unless the owner turns on
  `allowManagedChildren` in the MCP policy (migration 0134, `mcpPermitted`). The owner asked for
  this to be an admin setting, default blocked.

## Owner decisions (2026-11-10)
Linux server is a send-file target (into Downloads); Josi sends files when asked
(text files she writes); one new draft release when this lands; login terminal may run
any command shown on the card; live view owner-only with grants; sign-ins persist until
cleared; light thinking by default; live view opens inside the chat.
Later the same day: setup asks account or SMTP before showing either form; choosing an
account saves the keys, connects it and tests it in setup; Josi's own email goes out
through it; it also turns on sign-in with that provider; Microsoft sign-in is added;
with no public HTTPS address the account choice is shown but off; all in beta.11.

## Where things are
Test VMs and builds on claw `roman@10.10.1.3` (`~/josi-linux`); VMs `josi-debian13-vm`
(ssh -p 2223) and `josi-ubuntu2404-vm` (-p 2224) via claw; build with
`DOCKER_CONFIG=~/josi-linux/docker-anon scripts/linux/build-release.sh --version X
--skip-provision`. Claw itself runs the owner's Josi 1.1.6: do not upgrade it unasked.

## beta.25 (2026-11-12, about 17:30 PST): the fix list and the Daily Brief

Built on claw (`build-27.log`, 13 files, both processors, claw's source left clean) from the commits after `4a70e420`. Written by the Windows-side session that took the owner's "go build it all" (list: `docs/LINUX_FIX_LIST.md`, "STATUS after beta.25").

- **Old versions** (fix 10): an upgrade keeps the running version and the one just replaced, removes the rest only after a good start (`prune_old_versions` in `lifecycle.py`); before copying, `ensure_space` names a full disk in plain words and first removes old versions if that makes room; the installer script checks 6 GB free on `/var/lib` before the package step.
- **Goals** (1 to 4): a goal that asked a question while its own request was open now notices when that request was carried out and goes on (`reconcileWorkGoals`); a request prepared again after expiring is followed by the goal (`relinkWorkGoalTask`); an expired approval posts a message in the conversation; goal prompts ask for a conversation (say it, save a question, stop) and for timed waits on replies. The 15-minute approval limit is unchanged: Roman's call.
- **Typed yes** (6): `resolveConversationalAction` accepts a yes from a client that names no message when it is the only thing said since the request. **A deliberate loosening of "arrival order is not consent": Roman should confirm.** A client naming a different message is still refused. Josi's wording is "Approve it with the button below, or just say yes or no" (5).
- **Admin "Josi's own email"** (9): `/api/admin/mail-account`, card on Admin, Overview.
- **Daily Brief + Memory** (B2): `docs/DAILY_BRIEF.md`. Migration 0135. Both switches start OFF. Page "Daily brief" in the menu.
- **Typed-installer test** (8): `scripts/linux/e2e-typed-install.py` drives the installer through a real terminal with typed answers and checks the machine ended as typed. It found nothing wrong on Debian 13 (7 of 7), and its first run showed it needed the "address on your network" answer, now included. It installs for real: run it on a VM that was purged first (`sudo josi-uninstall --purge`). Fresh only; on a machine with Josi the update question appears instead.
- **Not done:** fix 7 (the installer ghost's animation) waits for Roman to say what looks wrong. **Not tried:** the goal prompts, the brief and the notes tools with a real model; the brief against a real mailbox; Wayland etc. as before. The Docker images are still beta.24 (not rebuilt).
- **Tests:** typecheck clean; full suite on Windows 4730 passed, 34 failed: 22 are the known list and 12 are Windows-host checks (file modes, symlinks, Mac Doctor, Windows antivirus, LAN address, tunnel key store), none touching this work; the same files were not rerun on Linux. New tests: `goalFollowsRequest`, `briefMemory`, `dailyBrief`, `brief` (API), `systemMailAccount`, lifecycle Python tests (36 OK on claw), actionState additions.
- **VMs:** Ubuntu 24.04 and Debian 13 upgraded from beta.24: `e2e-fake` 9/9, `e2e-pc` 5/5, `e2e-signin` rc 0 on both. The Debian VM was then purged and installed fresh by the typed test, and is left running beta.25 on port 8099.
- Next version is beta.26, next log `build-28.log`. Gate is Roman's; he upgrades it himself.

## beta.30 (2026-11-13): the ghost that vanished after a quiet spell

Commit `42f1e1d0`, built on claw (`build-32.log`, 13 files, both processors). Upgrade from beta.29 passed `e2e-fake` 9/9, `e2e-pc` 5/5 and `e2e-signin` on the Ubuntu 24.04 and Debian 13 VMs. LAN installer (`http://10.10.1.3:18099/linux`) and the one GitHub draft are beta.30; the beta.29 draft is deleted. The Docker images are still beta.29 (not rebuilt).

- **Cause (found from a screenshot of the web chat at dt.heyjosi.com):** after 20 quiet seconds the stage asks for the resting clip `gentle-float`, which had never been loaded. If that one request failed (a dropped connection or tunnel hiccup after idle), `Ghost.tsx` set `failed` for good and drew the still image `/ghost/arms-open.png`; with the connection still down that plain image showed as a broken-image icon. The server serves all the clips fine.
- **Fix:** a failed clip is retried (4, 8, 16 s, then every 30 s, or at once when the tab comes back or the network returns); the eight looping clips are fetched once into memory (`warmClips`, blob URLs) a moment after the page loads, so the resting clip plays even if the connection has dropped; the still hides itself if it will not load. `apps/web/src/lib/ghost.ts`, `components/ghost/Ghost.tsx`, tests in `apps/web/test/ghostKeep.test.ts`.
- **Not tried:** in a real browser against a flaky connection (the pieces are tested; the behaviour on screen is not). Safari uses the `.mov` clips; they are held the same way.
- Next version is beta.31, next log `build-33.log`.

## beta.31 (2026-11-13): beta sign-up and crash reports
Built on claw (`build-33.log`, 13 files, both processors); upgrade passed `e2e-fake` 9/9, `e2e-pc` 5/5, `e2e-signin` on the Ubuntu 24.04 and Debian 13 VMs. LAN installer and the GitHub draft are still beta.30 (not swapped). Full design in `docs/CRASH_REPORTS.md`.
- Tested end to end against a Netlify draft of the site (Supabase project `kgyudhatwvdubetvefjw`, tables from `beta.sql` in josi-app `site/beta-onboarding`): sign-up, token email, `/api/report` stores + emails `[Josi crash] ...`, revoked token answers 403, the all-in-one image `josi-allinone:v6-b31` installed with `JOSI_TESTER_TOKEN`, a forced browser crash was scrubbed (home path to `~`, IP and email removed) and arrived by email.
- **Bug found by that test, fixed after beta.31** (commit `3855ece9`): Josi's services start with a wiped environment (`Runtime.mjs` deletes `process.env`), so `JOSI_REPORT_URL` never reaches them. The report address can now come from `report_url` in `/etc/josi/tester.json` (first boot writes it from the container env); a 404 is retried. beta.31 still only has the default `https://heyjosi.com/api/report`, which is right for production once the site is live. **Next beta is beta.32 (log `build-34.log`) and should carry this.**
- The production site is not deployed yet (only a draft), so `https://heyjosi.com/api/report` answers 404 today.

## beta.32 (2026-11-13): the report-address fix
Commit `307f19db`, built on claw (`build-34.log`, 13 files). Upgrade from beta.31 passed `e2e-fake` 9/9, `e2e-pc` 5/5, `e2e-signin` on both VMs. LAN installer is beta.32. The GitHub draft is still beta.30 (not swapped; publish only when Roman says). The all-in-one image `josi-allinone:v6-b32` (docker box, `~/josi-allinone/dist/`: `install.sh`, `josi-allinone-v6-b32.tar`) carries beta.32 and is the installer's default image; tested with a fresh fake tester against the Netlify draft: first boot wrote `report_url` into `/etc/josi/tester.json`, a forced crash was sent, scrubbed and emailed. Next version beta.33, log `build-35.log`.

## beta.33 (2026-11-14): first open starts setup, Unraid, tunnel
Commit `32a7aa10`, built on claw (`build-35.log`, 13 files). Lifecycle (37), CLI contract (28) and universal installer (7) tests pass on claw; the gate and model-suggestion tests (10) pass on Windows. Next version beta.34, next log `build-36.log`.

- **First open starts setup, no link.** `JOSI_OPEN_SETUP=1` (install.json `openSetup`, `--open-setup`, lan address only; the Docker first boot turns it on, `JOSI_OPEN_SETUP=0` keeps the link). `GET /api/onboarding/state` says `openSetup: true` and `POST /api/onboarding/claim` starts a setup session, only while no owner exists, only for a private-network client, and never when a tunnel or proxy header (`cf-connecting-ip`, `cf-ray`, `forwarded`, `x-real-ip`, `true-client-ip`) is present. The web page asks on first open. Tried on a fresh container on the Unraid box (10.10.1.239:8090): a browser with no link went straight to "Step 1 of 9"; a request with `cf-connecting-ip` was refused.
- **Model step prefill.** `/api/setup/state` carries `localModel` (Ollama on 127.0.0.1:11434, the Josi model first); the model step fills address and model. API checked on the Unraid test container; the filled form itself was not looked at (it needs an owner account first).
- **Unraid all-in-one.** Installer: Unraid mode (downloads to the array, checks Docker's disk, NVIDIA plugin hint), a WebUI label so the Docker tab shows an Open link, `--tunnel-token-file FILE` (runs a separate cloudflared container; its Cloudflare route must point at `http://172.17.0.1:PORT`), recreates the container when `--public-url` or `--port` changes, stops the old container gracefully (`docker stop -t 180`) before replacing it. A killed container left Postgres a stale lock file and the upgrade inside the new one failed at `pg_ctl`; stop first.
- **Browser restart loop fixed in the all-in-one image:** the image has no Xvfb, but first boot enabled Josi's own browser. The image now sets `JOSI_BROWSER=0`.
- **All-in-one image `josi-allinone:v6-b33`** (Josi beta.33, the v6 model): built on the Unraid box from `/mnt/user/appdata/josi-allinone-build` (recipe recovered from the session; `build.sh`). 12.9 GB tar.
