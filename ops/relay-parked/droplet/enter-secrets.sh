#!/bin/bash
# Asks for the settings only you hold. Nothing you type is shown or logged.
# Press Enter to keep a value that's already saved. Run: bash /opt/heyjosi/enter-secrets.sh
set -e
cd /opt/heyjosi; umask 077; touch secrets.env; chmod 600 secrets.env
save() { grep -v "^$1=" secrets.env > secrets.tmp || true; printf '%s=%s\n' "$1" "$2" >> secrets.tmp; mv secrets.tmp secrets.env; }
ask() { local have=""; grep -q "^$1=" secrets.env && have=" (saved, Enter keeps it)"; read -rsp "$2$have: " v; echo; [ -n "$v" ] && save "$1" "$v"; return 0; }
ask DATABASE_URL "Supabase pooler connection string, with the password in it"
ask STRIPE_SECRET_KEY "Stripe TEST secret key (sk_test_...)"
ask STRIPE_WEBHOOK_SECRET "Stripe webhook secret (whsec_...)"
ask OPENAI_API_KEY "OpenAI API key"
ask GOOGLE_CLIENT_ID "Google client ID"
ask GOOGLE_CLIENT_SECRET "Google client secret"
read -rsp "Resend API key (re_...): " r; echo
[ -n "$r" ] && save SMTP_URL "smtps://resend:$r@smtp.resend.com:2465"
if ! grep -q '^STRIPE_PRICE_CONNECT=' secrets.env && grep -q '^STRIPE_SECRET_KEY=' secrets.env; then
  k=$(grep '^STRIPE_SECRET_KEY=' secrets.env | cut -d= -f2-)
  echo "Making the Stripe test prices..."
  docker run --rm -i -e STRIPE_SECRET_KEY="$k" node:22-bookworm-slim node --input-type=module - < src/apps/hosted/scripts/stripe-test-setup.mjs | grep '^STRIPE_PRICE_' >> secrets.env
fi
echo "Saved:"; cut -d= -f1 secrets.env
