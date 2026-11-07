# Parked: the Josi relay and Hey Josi accounts

Parked on 2026-11-06, when heyjosi.com moved to a plain website on Netlify. The
beta is self-hosted with direct address connections, so nothing here is running.
This folder and the tag `relay-parked-2026-11-06` are what you need to bring it back.

## What was running

| Piece | Where | Notes |
|---|---|---|
| Relay | Cloudflare Worker `josi-relay` on `relay.heyjosi.com` | Durable Objects `Site`, `Limit`, `Invite`, `Name`. `OPEN_RELAY=0`. Code and settings in `worker/` |
| Accounts service | DigitalOcean Droplet `heyjosi-accounts`, 165.227.188.169, NYC3, $12/mo | `apps/hosted` in Docker behind Caddy, built from commit `9324835`. Files in `droplet/` |
| Accounts database | Supabase project `kgyudhatwvdubetvefjw`, schema `heyjosi` | Not on the Droplet. Migrations are in `apps/hosted/supabase/migrations` |
| Mail | Resend through `smtp.resend.com:2465` | DigitalOcean blocks ports 25, 465 and 587 |
| Payments | Stripe test mode, webhook `we_1UYjtnA1syxoZwwLUqa09U1j` | Sends to `https://accounts.heyjosi.com` |

There were no systemd units or nginx config of ours: Docker restarts the containers
and Caddy handles TLS. The Droplet held no database and no Docker data worth
keeping, only Caddy's certificates, which it makes again.

## Settings

Names only, never values. These lived in `/opt/heyjosi` on the Droplet, and all
three files are in the final snapshot `heyjosi-accounts-final-2026-11-06`.

- `settings.env`: `NODE_ENV`, `PORT`, `PUBLIC_DOMAIN`, `CLIENT_IP_HEADER`, `RELAY_URL`, `MAIL_TRANSPORT`, `MAIL_FROM`, `PUBLIC_ORIGIN`
- `generated.env`: `ACCOUNT_DATA_KEY`, `STATE_SIGNING_KEY`, `HOSTED_NOISE_PRIVATE_KEY`, `RELAY_GRANT_PRIVATE_KEY`
- `secrets.env`: `DATABASE_URL`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CONNECT`, `STRIPE_PRICE_CONNECT_AI`, `STRIPE_PRICE_TOPUP_10`, `STRIPE_PRICE_TOPUP_20`, `OPENAI_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SMTP_URL`

`ACCOUNT_DATA_KEY` matters most: without it, the encrypted data in Supabase can't
be read. The two public keys are in `droplet/public-keys.txt`. If
`RELAY_GRANT_PRIVATE_KEY` changes, `ACCOUNTS_KEYS` in the Worker has to change with it.

## Bringing it back

1. Check out the tag: `git checkout relay-parked-2026-11-06`.
2. Make a Droplet from the snapshot. To start clean instead, make a 2 GB Ubuntu 24.04
   Droplet, install Docker, copy `droplet/` to `/opt/heyjosi` and run
   `bash /opt/heyjosi/enter-secrets.sh`.
3. If the snapshot is gone, restore `generated.env` from your saved copy. Making new
   keys loses the encrypted account data and breaks every paired device.
4. Send the source and build it (from the repo root):
   `git archive HEAD package.json package-lock.json tsconfig.base.json packages apps/hosted apps/api/package.json apps/worker/package.json apps/web/package.json apps/desktop/package.json`,
   copy it to `/opt/heyjosi/src`, then run `build.sh`.
5. Run migrations and start it:
   `docker compose -p heyjosi run --rm -T hosted node apps/hosted/dist/migrate.js`, then
   `docker compose -p heyjosi up -d --force-recreate hosted`.
6. DNS: add `accounts.heyjosi.com` as a **proxied** A record to the Droplet.
   `droplet/ufw-rules.txt` only lets Cloudflare's addresses reach ports 80 and 443,
   so a DNS-only record will not connect.
7. Worker: from `ops/relay-parked/worker`, run `npm install` and
   `npx wrangler deploy -c wrangler.parked.toml`. That recreates `relay.heyjosi.com`.
   **Never run a plain `wrangler deploy` from `services/relay`.** That config has the
   wildcard route and an empty `ACCOUNTS_KEYS`, which would take over every
   `*.heyjosi.com` name and shut the relay to everyone.
8. Website: in `vaxman14/josi-app`, build with `ACCOUNTS_ENABLED=true node scripts/build-site.mjs`.
9. Check the Supabase project is awake (free projects pause when idle), the Stripe
   webhook still exists, and the Google client still allows the callback on
   `https://accounts.heyjosi.com`.

## DNS

The full zone before the move is in `ops/dns/heyjosi-cloudflare-export-2026-11-06.txt`.
It leaves out `relay.heyjosi.com` (AAAA `100::`), because Cloudflare makes that record
for the Worker's custom domain and step 7 makes it again.
