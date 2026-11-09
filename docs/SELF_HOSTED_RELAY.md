# Run your own relay

The relay is in `services/relay`. It needs a Cloudflare account and a domain on
Cloudflare, and no Hey Josi account.

1. Edit `services/relay/wrangler.toml`: change `routes` and `PUBLIC_DOMAIN` to
   your domain, and set `OPEN_RELAY = "1"`.
2. Add a wildcard DNS record for your domain, proxied through Cloudflare, so
   `*.example.com` reaches the Worker.
3. Deploy:

```bash
cd services/relay && npm install && npm run build && npx wrangler deploy
```

4. In Josi, open **Hey Josi › Use your own relay** and enter
   `https://relay.example.com`.

`OPEN_RELAY` lets anyone who finds your relay register a server on it. They still
can't read anything, but they can use your Cloudflare quota. To restrict it,
leave it off and put your own public key in `ACCOUNTS_KEYS`, then sign grants
(see `readGrant` in `services/relay/src/index.js`).

A relay you run has the same limits as ours, with you in our place. See
[what the relay can and can't see](RELAY_PRIVACY.md).

To try it locally, with `http://alice.localhost:8799`:

```bash
cd services/relay && npx wrangler dev -c wrangler.dev.toml --port 8799 --ip 127.0.0.1
```
