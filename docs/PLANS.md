# Plans

Josi CE is free. The plans add a way to reach it from anywhere, and optionally
include AI. Prices aren't final, and billing runs in Stripe test mode for now.

| | Free | Connect | Connect + AI |
|---|---|---|---|
| Price | $0 | about $8/mo | about $20/mo |
| All of Josi CE | Yes | Yes | Yes |
| Your own AI key | Yes | Yes | Optional |
| Relay and `<you>.heyjosi.com` | No | Yes | Yes |
| Google sign-in with no Google setup | No | Yes | Yes |
| AI included | No | No | Up to your allowance |

## The AI allowance

Connect + AI includes a monthly dollar allowance on OpenAI's models. The default
model is GPT Luna. Sol costs more per message, so it uses the allowance faster.

- **One pool per household.** Everyone in a household draws from the same
  allowance. The owner can also give any member their own hard limit.
- **Top-ups:** $10 or $20. They add to the pool and carry over.
- **A hard stop.** Before each AI call, Josi sets aside the most that call could
  cost. If that doesn't fit, the call isn't made, and Josi says why. Spending
  can't pass the limit, even with several people using Josi at once. Near the
  limit, a long request can be refused while a little allowance is left.
- **What's kept:** token counts and cost per account. Never the text.

See usage on the Hey Josi page on your server, and on your account page.

## When a plan ends

Your server and everything on it keep working on your own network. Your address
pauses until you renew. Nothing is deleted. Google connections made through Hey
Josi stop refreshing, so use your own Google client or reconnect after renewing.

## Accounts

Sign up at heyjosi.com with an email and a password, and pick your address. Two
factor sign-in works with any authenticator app, with recovery codes. Account
data is stored in a Postgres database, separate from your server. An account
never opens your server: see [what the relay can and can't see](RELAY_PRIVACY.md).
