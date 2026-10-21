# Windows app build list

Roman's Josi CE feature list (October 21, "hey-josi-ce-features.txt") checked against the native Windows app on branch `windows/native-client-20261020`. The server already provides these features; the web app has a page for each. The Windows app needs its own screens for them.

**Have** = a working screen in the Windows app. **Partial** = some of it is there. **Missing** = no screen yet. **Server** = enforced by the server with nothing to show in the app. **Not this app** = another client or the installer.

## Build order for what is missing

1. **Connections** (your accounts): Google, Microsoft 365, Dropbox, Box and Nextcloud sign-in, per-capability switches, read/write separation, connection test, health, rotation and revoke. Includes **Developer services**: GitHub, GitLab, Cloudflare, Netlify, Vercel, Supabase, Docker Hub, GHCR, Railway, Render, Sentry, Linear, Jira Cloud, npm, Neon, Notion and Obsidian, with resource discovery and health checks. (Web: `Connections.tsx`.)
2. **Connectors** (administrator): register the Google, Microsoft, Dropbox and Box OAuth apps, Nextcloud settings, capability ceilings. Google sign-in in Josi depends on this. (Web: `admin/Connectors.tsx`, `admin/DeveloperServices.tsx`.)
3. **Files and storage**: Local Workspace and cloud folders (Google Drive, OneDrive, Dropbox, Box, Nextcloud, WebDAV); folder mapping (read-only and read/write), browsing, search, preview, download, create/edit/rename/move/delete with file-change approvals and recovery copies; indexing and full-text/semantic search; quotas; the local coding sandbox. Administrator storage settings and quotas. (Web: `LocalWorkspace.tsx`, `admin/Storage.tsx`.) Today only per-member folder permissions exist, under People.
4. **Calendar**: Google and Outlook calendars, multiple accounts, list/month/week/day views, source selection, default write calendar, time zone, all-day and recurring events, attendees, event details, sync status, conflicts. (Web: `Calendar.tsx`.)
5. **Contacts**: manual contacts, Google and Outlook contacts, import, two-way and automatic sync with intervals, deduplication, merging, conflicts, source tracking. (Web: `Contacts.tsx`.)
6. **Email templates**: templates, merge fields, HTML/mobile/plain-text previews, draft approval, send status. (Web: `EmailTemplates.tsx`.)
7. **Approvals**: pending requests (including custom API requests and prepared work), expiring approvals, approval history. (Web: `Approvals.tsx`.) Administrator **approval policy** ceilings. (Web: `admin/Policy.tsx`.)
8. **Personalization**: Assistant Soul, About Me, Working Style, personality presets with live preview, profile version history and restore. (Web: `Personalization.tsx`.) Memory already exists; add pinned memory and memory confidence where missing.
9. **Assistant migration**: OpenClaw, Hermes and Josi v1 imports with preview, receipts, rollback and the read-only imported archive. (Web: `AssistantMigration.tsx`.)
10. **Workflows and custom APIs**: Zapier, Zapier MCP, n8n (including private network) and Make, with workflow discovery, exposure controls, input schemas, approvals, execution, history and disconnect. Custom REST APIs with OpenAPI 3 import, endpoint allowlists, authentication types, write/delete approval and audit history. User and administrator screens. (Web: `Workflows.tsx`, `admin/Workflows.tsx`, `admin/CustomApis.tsx`.)
11. **Usage**: personal usage and cost, per-user budgets and allowances; administrator overview with per-user activity, interrupt-rate and correction-rate metrics. (Web: `Usage.tsx`, `admin/Overview.tsx`.)
12. **Workspace settings**: workspace name, **workspace time zone** (merges with the planned time zone setting: automatic from Windows, or pinned from a list), and the getting-started checklist. (Web: `admin/Workspace.tsx`, `admin/LaunchChecklist.tsx`.)
13. **Network and address**: LAN, public domain, reverse proxy, HTTPS and port after setup. (Web: `admin/Network.tsx`.)
14. **Operations**: Josi Doctor repair plans with approval and post-repair verification, release-update checks with release notes, backup-before-update, approved updates, health verification and rollback, diagnostics bundles with redaction, support-ticket preparation and approval. Today the app only runs a system check. (Web: `admin/Diagnostics.tsx`.)
15. **Backups**: off-site destinations (NAS, SMB, NFS, Amazon S3, S3-compatible, MinIO, Cloudflare R2, Backblaze B2) with encryption, recovery key, destination testing and folder browsing; integrity checks; database restore and credential-recovery verification. Today: back up now, portable export, history and download. (Web: `admin/Backups.tsx`.)
16. **PC control** (administrator): scopes, temporary access, pending actions and activity log. (Web: `admin/PcControl.tsx`.) Part of the Desktop + Chrome phase, with Windows Hello approval.
17. **Family module**: family workspace, managed child accounts, Josi-only schedules, message-minute limits, usage reports, parent conversation review, relationship verification, Child Mode, Parental Controls licensing. (Web: `Family.tsx`, `admin/ParentalControls.tsx`.)
18. **Native Windows extras**: Windows notifications for task updates and reminders; Windows Share target (share files and text into Josi); conversation search; audit events view; companion apps page (web `Apps.tsx`).

## Feature-by-feature status

### Clients and access
- Windows app: **Have** (this app). Web app, PWA, iPhone, iPad, Android, macOS, Linux apps: **Not this app**.
- Telegram, WhatsApp and Slack access: **Have** (Messaging Apps linking; administrator channel setup).
- Email and password sign-in: **Have**. Google Sign-In: **Have** (needs Connectors, item 2, to be usable). Apple Sign-In: **Not this app** (Apple platforms).
- Native push notifications, native reminders, native share intake: **Missing** (item 18).
- Secure device enrollment: **Partial** (Automation "This PC"; finished in the Desktop + Chrome phase).
- Multi-device sessions and session revocation: **Have**. Remembered sign-in: **Have**.

### Assistant
- AI chat, durable history, conversation task tracking, background task manager, task activity, retry and cancellation: **Have**.
- Streaming replies: **Partial** (replies arrive by refresh, not token streaming).
- Conversation search: **Missing** (item 18). Conversation privacy: **Partial** (verify against web).
- Scheduled tasks and reminders: **Partial** (scheduled continuation shown; no reminders screen, item 18).
- Exact-action approvals: **Have** (routine approval settings, step-up). Expiring approvals and approval history: **Missing** (item 7).
- Email drafting/sending, calendar and contact changes, custom API actions, workflow execution: done by the assistant on the server; their review screens are items 4–7 and 10.
- Tool-call receipts: **Partial** (task source work). Fabrication guards: **Server**.
- Usage tracking, cost tracking, per-user budgets, workspace usage metrics: **Partial** (Models page shows this month's totals and limits); full screens are item 11.

### Calendar — **Missing** (item 4)
### Email
- System SMTP and communications SMTP, SMTP sending, test sends: **Have** (Email Delivery).
- Gmail and Outlook reading/sending: through Connections (item 1); no mailbox screen in the web app either.
- Operational threads, sharing, trash and restore: **Server** tools; review screens with item 7.
- Templates, merge fields, previews, plain-text fallback, draft approval, send status: **Missing** (item 6).

### Contacts — **Missing** (item 5)

### Chat attachments
- File selection, upload, image vision, document/PDF/Office/OpenDocument/text extraction, HEIC/HEIF conversion, quotas, malware scanning (Windows antivirus), active-content rejection: **Have** (upload in chat; conversion, extraction and scanning are server-side).
- Camera capture and photo-library selection: **Not this app** (phones); Windows camera capture could be added later.
- Attachment download and deletion: **Partial** (verify; add if missing).

### Files and storage — **Missing** except folder permissions (item 3)

### Personalization and memory
- Personal memory, manual memory, proposed memories, confirmation, deletion, learning preferences: **Have**.
- Pinned memory, memory confidence: **Partial** (verify).
- Assistant Soul, About Me, Working Style, presets, live preview, version history, restore: **Missing** (item 8).
- OpenClaw, Hermes, Josi v1 migration and related: **Missing** (item 9).

### Model providers — **Have**
- All 22 API providers, local servers (Ollama, vLLM, LM Studio, LocalAI, OpenAI-compatible), ChatGPT and Claude subscriptions, primary and fallback, discovery, custom models, all capability tests, context detection, local-only mode, external-provider consent, token and spending caps.
- Per-user model allowances: **Partial** (verify; add with item 11 if missing).

### Cloud account connections — **Missing** (items 1 and 2)
### Developer integrations — **Missing** (items 1 and 2)
### Automation (Zapier, n8n, Make, custom APIs) — **Missing** (item 10)
- Browser and computer automation settings: **Have** (Automation section).

### Messaging channels — **Have**
- Telegram, WhatsApp Business and Slack setup, account linking, one-time link codes, health tests, enable/disable, identity revocation, delivery report. Telegram file handling and webhook management: **Server**.

### Voice Box
- Voice chat, speech-to-text, text-to-speech, voices, preview, speed, pause and detection settings, partial transcription, interruption: **Have**.
- Voice Box install, update, rollback, restart, uninstall: **Partial** (verify the administrator controls).

### Security and identity
- Super-admin and member roles, invitations, password setup and reset links, MFA (TOTP) and recovery codes, session revocation, password step-up, Master Vault (lock, unlock, recovery key, all item types), personal approval settings: **Have**.
- Local password-reset utility: **Not this app** (server tool; could be wired into Server later).
- Approval-policy ceilings: **Missing** (item 7). Audit events: **Missing** (item 18).
- Owner isolation, encrypted credentials, installation master key, rate limiting, CSRF, secret-safe diagnostics: **Server**.

### Administration
- Setup wizard, machine checks, user management, model administration, channel administration: **Have**.
- Storage administration: **Partial** (folder permissions per member; item 3).
- Connector, integration and workflow administration: **Missing** (items 2 and 10). Approval-policy administration: **Missing** (item 7).
- Workspace name and time zone, first-run checklist: **Missing** (item 12).
- Usage overview and per-user metrics: **Missing** (item 11). Anonymous telemetry controls: **Partial** (setup step only; add a setting).
- Network address, LAN, domain, reverse proxy, HTTPS, port: **Partial** (setup step only; item 13).

### Backups and recovery
- Full backups, portable exports, downloads, progress, history: **Have**.
- Integrity checks, restore, credential-recovery verification, all off-site destinations, encryption and testing: **Missing** (item 15).

### Operations
- System health checks: **Have**. Everything else in the list: **Missing** (item 14).

### Deployment — **Not this app**
- Docker, Linux and macOS installers, Caddy, Portainer, Unraid, TrueNAS, OCR and ClamAV services. The Windows installer, uninstaller and recovery installer are the packaging phase.

### Family module — **Missing** (item 17)
