# Setting up the hosted side

For the owner of heyjosi.com. Nothing here has been done yet. Self-hosters don't
need this page.

Three things run: the **relay** (Cloudflare Worker, `services/relay`), the
**hosted service** (Node, `apps/hosted`), and a **Supabase** Postgres database.

## 1. Supabase

Make a project. Run the migrations as the same role the service connects with, so
that role owns the tables. Tables live in a private `heyjosi` schema with row
security on and no policies, so Supabase's public API can't reach them.

```bash
DATABASE_URL='<your connection string>' node apps/hosted/dist/migrate.js
```

The pooled connection on port 6543 is the one to try first. It's untested.

## 2. Keys

Make four random 32-byte values, base64url: `ACCOUNT_DATA_KEY`,
`STATE_SIGNING_KEY`, `HOSTED_NOISE_PRIVATE_KEY`, `RELAY_GRANT_PRIVATE_KEY`. Keep
them out of the repo. Losing `ACCOUNT_DATA_KEY` loses every 2FA secret. Changing
`HOSTED_NOISE_PRIVATE_KEY` unlinks every server.

## 3. Cloudflare

- DNS: add a wildcard `*.heyjosi.com`, proxied. `AAAA 100::` works as a placeholder,
  since the Worker answers. Explicit records (`www`, `ce`, `get`, `help`) keep
  working, and the Worker passes reserved names through.
- Add `relay.heyjosi.com` (the Worker's custom domain in `wrangler.toml`).
- Point `heyjosi.com` at the hosted service, for example with a Cloudflare tunnel.
- Set `ACCOUNTS_KEYS` in `services/relay/wrangler.toml` to the Ed25519 public key
  of `RELAY_GRANT_PRIVATE_KEY`, then:

```bash
cd services/relay && npm install && npm run build && npx wrangler deploy
```

- Ask to add `heyjosi.com` to the Public Suffix List. It isn't urgent: each address
  has its own origin and Josi sets no cookies at those addresses. It does keep
  browsers treating every address as fully separate.

## 4. Stripe (test mode)

The service refuses to start with anything but a `sk_test_` or `rk_test_` key, and
refuses live webhook events. Going live needs a code change and a decision.

```bash
STRIPE_SECRET_KEY='<test key>' node apps/hosted/scripts/stripe-test-setup.mjs
```

That prints the four price ids: `STRIPE_PRICE_CONNECT`, `STRIPE_PRICE_CONNECT_AI`,
`STRIPE_PRICE_TOPUP_10`, `STRIPE_PRICE_TOPUP_20`. Add a webhook at
`https://heyjosi.com/stripe/webhook` for `checkout.session.completed`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`
and `invoice.payment_failed`, and put its secret in `STRIPE_WEBHOOK_SECRET`.

## 5. Google console

Use the verified Hey Josi OAuth client, type Web application. Add the redirect
`https://heyjosi.com/oauth/google/callback`. The scopes must stay exactly: `openid`,
`userinfo.email`, `gmail.readonly`, `gmail.send`, `calendar.readonly`, `calendar`,
`contacts.readonly`, `contacts`, `drive.readonly`. Put the client id and secret in
`GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## 6. OpenAI

Make a separate project with its own key for `OPENAI_API_KEY`, and set a monthly
budget on it as a backstop to Josi's own cap. Check the prices in
`heyjosi.models` against OpenAI's pricing page before charging anyone: they were
taken from press coverage, not from OpenAI directly.

## 7. Mail and running it

Set `MAIL_TRANSPORT=smtp` and `SMTP_URL`. Then set `RELAY_URL`,
`PUBLIC_ORIGIN=https://heyjosi.com` and `PUBLIC_DOMAIN=heyjosi.com`.
`CLIENT_IP_HEADER=cf-connecting-ip` makes rate limits see the real address behind
Cloudflare. `apps/hosted/.env.example` lists everything.

```bash
npx tsc -b apps/hosted && node apps/hosted/dist/server.js
```

## Local testing

```bash
JOSI_BROWSER_E2E=1 npx vitest run apps/hosted/test/fullstack
```

That runs the real relay, hosted service and server together, with Google and
Stripe faked. `packages/tunnel/test/browser` does the same with real Chrome.
