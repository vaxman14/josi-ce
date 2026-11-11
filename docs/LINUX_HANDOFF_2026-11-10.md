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
