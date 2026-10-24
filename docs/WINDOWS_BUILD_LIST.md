# Windows app build list

Roman's Josi CE feature list (October 21, "hey-josi-ce-features.txt") checked against the native Windows app on branch `windows/native-client-20261020`. The server already provides these features; the web app has a page for each. The Windows app needs its own screens for them.

**Have** = a working screen in the Windows app. **Partial** = some of it is there. **Missing** = no screen yet. **Server** = enforced by the server with nothing to show in the app. **Not this app** = another client or the installer.

## Build status (October 21)

Built in the Windows app, compiled, and opened on the test server (39 sections, no crashes); not yet tested against the real server: items 1–3, 5–15, 17–28, 30–33, plus remembered sign-in and conversation search. Item 34 is wired: the installer kit now carries the app (`scripts/windows/Build-NativeApp.ps1`), setup installs it beside the server, and the Start menu opens it. Item 35 has its script (`scripts/windows/Sign-WindowsArtifacts.ps1`).

Server changes made for the app: connections started from the app finish through `josi://connections/callback` with the same session (`connectorRoutes.ts`), and approval history (`GET /api/assistant/approvals/history`).

## Build status (October 22, on the new PC)

- **27 Desktop control** is built: the Josi app is the executor for desktop work. The assistant has `desktop_list_windows`, `desktop_read_window` (Windows UI Automation, controls with ids), `desktop_screenshot` (sent to the model as an image), `desktop_click`, `desktop_type`, `desktop_keys`, `desktop_launch`, `desktop_close_window` and, for programs UI Automation cannot read, `desktop_click_point` (a pixel in the last screenshot of that window, mapped back to the screen and re-checked before the click; `desktop_type` without an element id then types into the focused control) (`packages/agent/src/pcDesktopTools.ts`, `apps/windows-native/src/DesktopExecutor.cs`). Every call is a PC Control request scoped to the exact program (new read-only action `desktop.view`; actions use `app.launch`, `app.control`, `app.close`). A banner at the top of the window shows who is in control with Pause and Stop; any real mouse or keyboard input cancels the current action and keeps Josi off the desktop for 20 seconds. Verified on this PC from the real tool path: list, read, screenshot, click by point and focused typing (against Character Map). Clicking by control id and the banner are built and not yet tried by Roman.
- **Full control** under PC Control: one standing grant for everyday browser, folder, application and desktop actions; purchases, deleting, credentials, installs, security settings, commands and elevation still ask (`PC_FULL_CONTROL_ACTIONS`). Password once to turn on; the emergency stop clears it. Migration 0102.
- **Settings changes by talking to Josi**: `list_josi_settings` and `propose_josi_setting_change` prepare an exact change; a popup (and the Approvals page) asks the person to make it live; their own app applies it with its own session. Administrator settings wait for the super-admin, who can deny anything and can make member changes wait for them. A sensitive change applied by a member is emailed to every super-admin at once when system mail works. Migration 0103, `apps/api/src/http/settingsChangeRoutes.ts`.
- **Live model-check progress** (`GET .../probe/progress`), a shared animated working indicator for every wait, and real failure codes from the browser extension with a 72 KB photo budget.
- Layout: one left-aligned content column and one spacing rhythm for every section.

Still open:
- **4 Google live test: done on October 23.** `https://ce.heyjosi.com` reaches this PC's dev server through the Cloudflare Tunnel "josi-thebutt" (connector started by `Start-DevServer.ps1` from `C:\Dev\josi-dev\cloudflared`, token in `data\secrets\cloudflared-token`; `runtime.json` has `publicUrl` https and `cookieSecure=false` for the local native app). Roman registered the Google application from the redesigned Connectors page and connected his Google account from the Windows app: consent in Chrome, callback on the public address, return into the app, connection active with every capability off until switched on. Sign in with Google itself (the login page button) is registered too and not yet tried.
- **16 Streaming replies**: the server does not stream replies to any client yet; the app now checks every second while a reply is written. True streaming is a server change.
- **27 Chrome acceptance** on Roman's page; **29 Windows Hello approvals** need the server's protected-confirmation enrollment (currently Mac-only) ported to Windows.
- **34 full installer build**: needs the pinned runtimes and helper builds rebuilt on this PC, then the installer compiled.
- **35 signing**: needs Roman's Azure Trusted Signing sign-in.
- Family and Companion apps show "coming soon", matching the web app, where those features are not released.

Agreed with Roman on October 22, to start after the current testing round:
- **36 Dedicated server option**: the Josi server on its own machine (LAN or a public HTTPS address), the app and PC Control connecting to it from the PCs. Needs: the PC tools offered by a server that is not itself the Windows native runtime (today `pcBrowserToolAvailability` and `pcDesktopToolAvailability` return nothing unless the server runs on Windows with `JOSI_NATIVE_RUNTIME=1`); a per-device identity instead of the single fixed `local-windows-host` so two PCs on one account do not collide; the Network page finished on Windows (item 13: LAN, domain, reverse proxy, HTTPS, port). The extension itself needs no change: it only ever talks to the Josi app on the same PC over native messaging.
- **37 Extension on other browsers and in the stores**: the build already produces Chrome, Brave, Firefox and Safari packages (`scripts/unified/build-browser-extensions.mjs`), but only the unpacked Chrome build has been loaded. Test Brave, Firefox and Edge (Edge loads the Chrome build) with the native host registration for each; Safari needs its containing macOS app. Then publish: Chrome Web Store, Edge Add-ons, Firefox Add-ons, App Store for Safari. Publisher accounts and the one-time fees are Roman's.
- **38 Repeat-step planner** for repetitive work ("describe photos 1 to 53", "do this for every row"). Today the model writes its own checkpoints and plan revisions, each costing a whole model step in the ChatGPT one-step mode (7 of 12 steps went to bookkeeping in the October 22 run), and the checkpoint rules built for consequential actions refuse read-only work. Build: a plan step kind that records a range and lets the server drive the loop itself (view, describe, next, count saved after each item, no model-written checkpoint); looser rules for read-only goals so a refused checkpoint is a note, never a stop; one plain progress line in the chat ("photo 14 of 53") instead of the recovery card. Roman's point from the October 22 run: the Task Manager card showed every step as Pending while Josi was busy viewing photos, because steps only move when the model writes a checkpoint; progress must come from what the tools actually did (the PC Control activity and tool receipts), updated live, not from the model's bookkeeping. Background continuation already runs unlimited segments by default (per-goal run limit and deadline under Work limits), so this is about spending steps on the items, not on bookkeeping.
- **39 In-place refresh pass** (the "jerk" on every click). Today a click runs the model's helper, which fires a change notification before and after the work; each notification makes the workspace shell rebuild the whole sidebar (`Workspace.cs` RenderNav, RenderThreads, RenderFooter clear and recreate every button) and makes the open section rebuild its page from `Build()` and swap in a new scroll viewer (`SectionView.Render` in `Sections.cs`), with the page toggled disabled while busy; the 3-second poll (1 second while a reply is written) does the same when anything changed. Build: sidebar built once and updated in place (highlight, counts); sections update values in place or replace only the content inside the existing scroll viewer so the scroll position never resets; busy shown by the working indicator without disabling the page. Touches the shared page base and every section; the chat view already refreshes only on a content change and is the model to follow.
- **40 Web app redesign** (agreed October 23). The web app (`apps/web`, React and Vite) still has the original Josi look; every design decision of this session lives only in the Windows app's C# (dark palette, orange accents, one left-aligned content column with the 1040 px width and 18 px rhythm, sidebar sections, cards, pills, the working indicator with its clock, the work card beside the chat, the live model check). Seen from a phone at `https://ce.heyjosi.com` the difference is obvious. Scope: the shared shell (`components/layout/Shell.tsx`, `mobileNavigation.ts`) and the ui kit (`components/ui/index.tsx`, `index.css`), then the 25 pages and 21 admin pages on the same components, phone-first since that is where the web app is actually used. Same server, same routes, no API change. This is a redesign, not a port: nothing from the Windows app's layout code can be reused directly, only its decisions. Do it after items 36 to 39, or alongside 36 when the dedicated server makes the web app the daily client.
- **41 Connectors and Integrations as one page** (agreed October 23). Both answer the administrator's "what may people connect, and is it working"; the split by provider type (Google, Microsoft, Dropbox, Box versus GitHub, Netlify, Supabase, Notion…) sends people to the wrong page, as it did when Roman looked for the Google form under Integrations. Build: one sidebar entry under Administration named Connectors, a two-way switch at the top (Account providers · Developer services, the Task Manager's segmented control), connection health and the member ceiling at the bottom of the tab they belong to, the provider cards unchanged, the old "integrations" section key landing in the second tab. No server change. The web app has the same split (`admin/Connectors.tsx`, `admin/DeveloperServices.tsx`) and gets the same merge under item 40.

## Full build list

Everything still to do for the Windows app, in build order. It combines the missing and partial features below with the remaining plan items. Each item ends when it works against the development server and its click-through test passes.

### Phase 1 — Your accounts and data
1. **Connectors** (administrator): register the Google, Microsoft, Dropbox and Box OAuth apps and Nextcloud settings; administrator capability ceilings; developer-service settings. (Web: `admin/Connectors.tsx`, `admin/DeveloperServices.tsx`.)
2. **Connections** (your accounts): Google, Microsoft 365, Dropbox, Box and Nextcloud sign-in; incremental permissions, per-capability switches, read/write separation; connection test, health, credential rotation and revoke; per-user ownership. (Web: `Connections.tsx`.)
3. **Developer services**: GitHub, GitLab, Cloudflare, Netlify, Vercel, Supabase, Docker Hub, GitHub Container Registry, Railway, Render, Sentry, Linear, Jira Cloud, npm, Neon, Notion and Obsidian; repository, package, project, deployment-site, organization, Notion page and Obsidian vault discovery; Obsidian Markdown reading; per-user permissions; health checks. (Web: `Connections.tsx`.)
4. **Google sign-in, live test**: once Connectors has Google, sign in with a real linked Google account.
5. **Files and storage**: Local Workspace; Google Drive, OneDrive, Dropbox, Box, Nextcloud and WebDAV folders; folder mapping (read-only and read/write); browsing, search, preview and download; create, edit, rename, move and delete with file-change approvals and recovery copies; document indexing, full-text and semantic search, versioning, archive indexing; storage quotas, file-count and file-size limits. Administrator storage settings. (Web: `LocalWorkspace.tsx`, `admin/Storage.tsx`.)
6. **Local coding sandbox**: JavaScript syntax checking and isolated execution with review. (Web: `LocalWorkspace.tsx`.)
7. **Calendar**: Google and Outlook calendars, multiple accounts and calendars; list, month, week and day views; source selection, primary calendar, default write calendar, time zone; all-day and recurring events, attendees, event details; sync status and conflict detection. (Web: `Calendar.tsx`.)
8. **Contacts**: manual contacts, Google and Outlook contacts, import, two-way and automatic sync with intervals, deduplication, merging, conflict handling, source tracking. (Web: `Contacts.tsx`.)
9. **Email templates**: templates, merge fields, HTML, mobile and plain-text previews, draft approval, send-status tracking; operational threads, sharing, trash and restore where the server shows them. (Web: `EmailTemplates.tsx`.)

### Phase 2 — The assistant
10. **Approvals**: pending requests (custom API requests, prepared work), expiring approvals, approval history. (Web: `Approvals.tsx`.)
11. **Approval policy** (administrator): approval-policy ceilings over personal settings. (Web: `admin/Policy.tsx`.)
12. **Personalization**: Assistant Soul, About Me, Working Style, personality presets with live preview, profile version history and restore; pinned memory and memory confidence. (Web: `Personalization.tsx`.)
13. **Assistant migration**: OpenClaw, Hermes and Josi v1 profile, memory and conversation-archive imports with preview, receipts, rollback and the read-only imported archive. (Web: `AssistantMigration.tsx`.)
14. **Workflows**: Zapier, Zapier MCP, n8n (including private network) and Make; workflow discovery, exposure controls, input schemas, preparation, approvals, execution, signed callbacks, history and disconnect. User and administrator screens. (Web: `Workflows.tsx`, `admin/Workflows.tsx`.)
15. **Custom APIs**: custom REST APIs, OpenAPI 3 import, endpoint allowlists, GET/HEAD actions, write and delete approval, bearer, API-key, basic and custom-header authentication, audit history. (Web: `admin/CustomApis.tsx`.)
16. **Streaming replies**: show the reply as it is written instead of on refresh.
17. **Conversation search** and **conversation privacy** controls.
18. **Reminders and scheduled tasks**: a screen for reminders and scheduled work.
19. **Usage**: personal usage and cost, per-user budgets and model allowances; administrator overview with per-user activity, interrupt-rate and correction-rate metrics. (Web: `Usage.tsx`, `admin/Overview.tsx`.)

### Phase 3 — Administration and operations
20. **Workspace settings**: workspace name; **time zone** (automatic from Windows by default, or pinned from a list); getting-started checklist; anonymous telemetry setting. (Web: `admin/Workspace.tsx`, `admin/LaunchChecklist.tsx`.)
21. **Network and address**: LAN, public domain, reverse proxy, HTTPS and port after setup. (Web: `admin/Network.tsx`.)
22. **Operations**: Josi Doctor repair plans with approval and post-repair verification; release-update checks and release notes; backup-before-update, approved updates, update health verification and automatic rollback; diagnostics bundles with redaction; support-ticket preparation and approval; liveness, readiness, worker, database, storage, notification and network health. (Web: `admin/Diagnostics.tsx`.)
23. **Backups**: NAS, SMB, NFS, Amazon S3, S3-compatible, MinIO, Cloudflare R2 and Backblaze B2 destinations; off-site encryption and backup recovery key; destination testing and folder browsing; integrity checks; database restore and credential-recovery verification. (Web: `admin/Backups.tsx`.)
24. **Voice Box administration**: install, update, rollback, restart and uninstall; NVIDIA acceleration option (finish where partial).
25. **Audit events** view and **local password reset** from the Server page.
26. **Finish partial items**: attachment download and deletion; check every "Partial" line below against the web app and close the gaps.

### Phase 4 — Desktop and Chrome
27. **Desktop + Chrome**: Josi works on this PC and in Chrome; Chrome extension loaded unpacked for testing; secure device enrollment for this PC. Needs Roman's test page.
28. **PC control** (administrator): exact scopes, saved scopes and temporary access, actions awaiting approval, activity log. (Web: `admin/PcControl.tsx`.)
29. **Windows Hello approvals**: protected approvals confirmed with fingerprint, face or PIN.

### Phase 5 — Windows extras and family
30. **Windows notifications** for task updates, approvals and reminders.
31. **Windows Share target**: share files and text into Josi from other apps; optional camera capture.
32. **Companion apps** page. (Web: `Apps.tsx`.)
33. **Family module**: family workspace, managed child accounts, Josi-only schedules, message-minute limits, child usage reports, parent conversation review, relationship-authority verification, Child Mode, Parental Controls licensing. (Web: `Family.tsx`, `admin/ParentalControls.tsx`.)

### Phase 6 — Packaging and release
34. **Windows installer**: one installer for the server and app, replacing the development setup; uninstaller and recovery installer; updates keep the remembered sign-in.
35. **Code signing** with Azure Trusted Signing (Roman signs in when ready).
## Feature-by-feature status

### Clients and access
- Windows app: **Have** (this app). Web app, PWA, iPhone, iPad, Android, macOS, Linux apps: **Not this app**.
- Telegram, WhatsApp and Slack access: **Have** (Messaging Apps linking; administrator channel setup).
- Email and password sign-in: **Have**. Google Sign-In: **Have** (needs Connectors, item 2, to be usable). Apple Sign-In: **Not this app** (Apple platforms).
- Native push notifications, native reminders, native share intake: **Missing** (items 18, 30 and 31).
- Secure device enrollment: **Partial** (Automation "This PC"; finished in the Desktop + Chrome phase).
- Multi-device sessions and session revocation: **Have**. Remembered sign-in: **Have**.

### Assistant
- AI chat, durable history, conversation task tracking, background task manager, task activity, retry and cancellation: **Have**.
- Streaming replies: **Partial** (replies arrive by refresh, not token streaming).
- Conversation search: **Missing** (item 17). Conversation privacy: **Partial** (item 17).
- Scheduled tasks and reminders: **Partial** (scheduled continuation shown; no reminders screen; item 18).
- Exact-action approvals: **Have** (routine approval settings, step-up). Expiring approvals and approval history: **Missing** (item 10).
- Email drafting/sending, calendar and contact changes, custom API actions, workflow execution: done by the assistant on the server; their review screens are items 7–10, 14 and 15.
- Tool-call receipts: **Partial** (task source work). Fabrication guards: **Server**.
- Usage tracking, cost tracking, per-user budgets, workspace usage metrics: **Partial** (Models page shows this month's totals and limits); full screens are item 11.

### Calendar — **Missing** (item 7)
### Email
- System SMTP and communications SMTP, SMTP sending, test sends: **Have** (Email Delivery).
- Gmail and Outlook reading/sending: through Connections (item 2); no mailbox screen in the web app either.
- Operational threads, sharing, trash and restore: **Server** tools; review screens with item 10.
- Templates, merge fields, previews, plain-text fallback, draft approval, send status: **Missing** (item 9).

### Contacts — **Missing** (item 8)

### Chat attachments
- File selection, upload, image vision, document/PDF/Office/OpenDocument/text extraction, HEIC/HEIF conversion, quotas, malware scanning (Windows antivirus), active-content rejection: **Have** (upload in chat; conversion, extraction and scanning are server-side).
- Camera capture and photo-library selection: **Not this app** (phones); Windows camera capture could be added later.
- Attachment download and deletion: **Partial** (verify; add if missing).

### Files and storage — **Missing** except folder permissions (item 5)

### Personalization and memory
- Personal memory, manual memory, proposed memories, confirmation, deletion, learning preferences: **Have**.
- Pinned memory, memory confidence: **Partial** (verify).
- Assistant Soul, About Me, Working Style, presets, live preview, version history, restore: **Missing** (item 12).
- OpenClaw, Hermes, Josi v1 migration and related: **Missing** (item 13).

### Model providers — **Have**
- All 22 API providers, local servers (Ollama, vLLM, LM Studio, LocalAI, OpenAI-compatible), ChatGPT and Claude subscriptions, primary and fallback, discovery, custom models, all capability tests, context detection, local-only mode, external-provider consent, token and spending caps.
- Per-user model allowances: **Partial** (verify; add with item 19 if missing).

### Cloud account connections — **Missing** (items 1–3)
### Developer integrations — **Missing** (items 1–3)
### Automation (Zapier, n8n, Make, custom APIs) — **Missing** (items 14 and 15)
- Browser and computer automation settings: **Have** (Automation section).

### Messaging channels — **Have**
- Telegram, WhatsApp Business and Slack setup, account linking, one-time link codes, health tests, enable/disable, identity revocation, delivery report. Telegram file handling and webhook management: **Server**.

### Voice Box
- Voice chat, speech-to-text, text-to-speech, voices, preview, speed, pause and detection settings, partial transcription, interruption: **Have**.
- Voice Box install, update, rollback, restart, uninstall: **Partial** (verify the administrator controls).

### Security and identity
- Super-admin and member roles, invitations, password setup and reset links, MFA (TOTP) and recovery codes, session revocation, password step-up, Master Vault (lock, unlock, recovery key, all item types), personal approval settings: **Have**.
- Local password-reset utility: **Not this app** (server tool; could be wired into Server later).
- Approval-policy ceilings: **Missing** (item 11). Audit events: **Missing** (item 25).
- Owner isolation, encrypted credentials, installation master key, rate limiting, CSRF, secret-safe diagnostics: **Server**.

### Administration
- Setup wizard, machine checks, user management, model administration, channel administration: **Have**.
- Storage administration: **Partial** (folder permissions per member; item 3).
- Connector, integration and workflow administration: **Missing** (items 1, 14 and 15). Approval-policy administration: **Missing** (item 11).
- Workspace name and time zone, first-run checklist: **Missing** (item 20).
- Usage overview and per-user metrics: **Missing** (item 19). Anonymous telemetry controls: **Partial** (setup step only; add a setting).
- Network address, LAN, domain, reverse proxy, HTTPS, port: **Partial** (setup step only; item 13).

### Backups and recovery
- Full backups, portable exports, downloads, progress, history: **Have**.
- Integrity checks, restore, credential-recovery verification, all off-site destinations, encryption and testing: **Missing** (item 23).

### Operations
- System health checks: **Have**. Everything else in the list: **Missing** (item 22).

### Deployment — **Not this app**
- Docker, Linux and macOS installers, Caddy, Portainer, Unraid, TrueNAS, OCR and ClamAV services. The Windows installer, uninstaller and recovery installer are the packaging phase.

### Family module — **Missing** (item 33)
