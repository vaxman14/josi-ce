#!/usr/bin/env node
// Makes the test-mode products and prices this service needs, and prints the
// lines to put in .env. Test mode only: a live key is refused before anything is
// sent. Running it twice makes a second set.
//
//   STRIPE_SECRET_KEY=sk_test_... node apps/hosted/scripts/stripe-test-setup.mjs
const key = process.env.STRIPE_SECRET_KEY ?? '';
if (!/^(sk|rk)_test_/.test(key)) {
  console.error('STRIPE_SECRET_KEY must be a test key (sk_test_ or rk_test_). Live keys are refused.');
  process.exit(1);
}

async function post(path, params) {
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message ?? `Stripe answered ${res.status}`);
  if (body.livemode) throw new Error('Stripe answered with a live object. Stopping.');
  return body;
}

const items = [
  { env: 'STRIPE_PRICE_CONNECT', name: 'Hey Josi Connect', cents: 800, monthly: true },
  { env: 'STRIPE_PRICE_CONNECT_AI', name: 'Hey Josi Connect + AI', cents: 2000, monthly: true },
  { env: 'STRIPE_PRICE_TOPUP_10', name: 'Hey Josi AI top-up, $10', cents: 1000, monthly: false },
  { env: 'STRIPE_PRICE_TOPUP_20', name: 'Hey Josi AI top-up, $20', cents: 2000, monthly: false },
];

for (const item of items) {
  const product = await post('/products', { name: item.name });
  const price = await post('/prices', { product: product.id, currency: 'usd', unit_amount: String(item.cents), ...(item.monthly ? { 'recurring[interval]': 'month' } : {}) });
  console.log(`${item.env}=${price.id}`);
}
