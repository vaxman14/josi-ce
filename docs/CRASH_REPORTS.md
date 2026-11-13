# Beta sign-up and crash reports

Three parts. The site and its functions live in `josi-app` (branch `site/beta-onboarding`: `josi-site/beta/`, `josi-site-functions/`); the app side lives here.

## 1. heyjosi.com/beta (and /he/beta, /ru/beta)

A form (name, email, OS, graphics card, RAM, use case, "send crash reports automatically") posts to `POST /api/signup`. The function stores a row in Supabase `beta_testers` with a random token, shows the install command

    curl -fsSL https://get.heyjosi.com/allinone | sudo JOSI_TESTER_TOKEN=<token> bash

and emails it via Resend. Limits: 5 sign-ups/hour per IP, 3/day per email (hashed with `IP_HASH_SALT`), a honeypot field and a minimum fill time. No third-party captcha.

## 2. `POST /api/report` (Netlify function)

Needs a known, non-revoked token (401 unknown, 403 revoked). 20 reports/hour per token, 256 KB cap. Stores in `reports`, emails the owner `[Josi crash] <name> v<version> <first error line>` (`[Josi feedback] ...` for feedback). `POST /api/tester-prefs` returns only the tester's automatic-reports choice, so the first-run question can default to it.

Netlify environment (site `heyjosi`): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `RESEND_API_KEY`, `REPORT_TO`, `IP_HASH_SALT`; optional `MAIL_FROM`, `INSTALL_COMMAND_TEMPLATE`. Tables: `josi-site-functions/supabase/beta.sql` (RLS on, no policies). To revoke a tester: `update beta_testers set revoked = true where email = '...'`.

## 3. In Josi

- Token: env `JOSI_TESTER_TOKEN` or `/etc/josi/tester.json`. The all-in-one `install.sh` passes it to the container; `josi-firstboot` writes the file. URL defaults to `https://heyjosi.com/api/report` (`JOSI_REPORT_URL` overrides).
- `packages/core/src/crashReport.ts`: scrubs chats, Vault data, emails, OAuth tokens, home paths (to `~`) and IPs; queues in the `crash_reports` table (disk queue if the DB is down); retries with backoff (1/5/30/120/360 min, 8 tries); `crash.flush` job every 120 s. Handlers are installed in the API and worker; the browser reports its own crashes.
- Owner choice `workspace.settings.crashReportsAuto`: on = silent send; off = a card with an editable report and Send / Don't send; unset = asked on first run. Settings has the switch; the menu has "Send feedback".
- Tests: `packages/core/test/crashReport.test.ts`, `apps/api/test/crashReports.test.ts`, `apps/web/test/crashReports.test.ts`, and `node --test josi-site-functions/test/functions.test.mjs` in the site repo.
