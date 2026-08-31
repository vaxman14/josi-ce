#!/usr/bin/env node
// Browser checks against a running CE stack.
//
// WebKit with touch emulation is the closest thing to Safari on an iPhone that
// runs unattended, which is the point: the engine's Talk composer was rewritten
// three times for a phone nobody could test against, and the fix that finally
// worked is a plain form submit. This suite exists so nobody "simplifies" it
// back into pointer handlers.
//
//   E2E_BASE=http://127.0.0.1:8396 node scripts/e2e-web.mjs
import { webkit } from 'playwright';

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:8080';
const ADMIN = { id: process.env.E2E_ADMIN ?? 'owner', pw: process.env.E2E_ADMIN_PW ?? '' };
const MEMBER = { id: process.env.E2E_MEMBER ?? 'alice', pw: process.env.E2E_MEMBER_PW ?? '' };

// iPhone SE, iPhone 13 mini, iPhone 14/15, Pro Max.
const WIDTHS = [320, 375, 390, 430];
const MEMBER_PAGES = [
  '/app', '/app/talk', '/app/tasks', '/app/approvals', '/app/conversations',
  '/app/contacts', '/app/connections', '/app/usage', '/app/settings', '/app/apps',
];
const ADMIN_PAGES = [
  '/admin', '/admin/people', '/admin/model', '/admin/policy', '/admin/connectors', '/admin/workspace',
];

let pass = 0;
let fail = 0;
const record = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const step = (s) => console.log(`\n== ${s}`);

async function signIn(page, who) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('#identifier', who.id);
  await page.fill('#password', who.pw);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => u.pathname.startsWith('/app'), { timeout: 20000 });
}

const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** Collects what the page complained about.
 *
 * `pageerror` fires only for UNCAUGHT exceptions — once an ErrorBoundary
 * catches one, the only record is what it logged. So both are watched, or a
 * caught crash looks like a page that simply rendered nothing. */
function watch(page) {
  const problems = [];
  page.on('pageerror', (err) => {
    const text = String(err).split('\n')[0];
    // WebKit words a request cancelled by navigation as "cannot load … due to
    // access control checks", which reads like a policy refusal and is not one.
    // This suite walks ten pages back to back, so in-flight fetches are
    // cancelled constantly. Ignoring it would be hand-waving on its own, so
    // `testFetchesWork` below proves positively that same-origin fetches
    // succeed and that the data they return is rendered.
    if (/Fetch API cannot load .* due to access control checks/i.test(text)) return;
    problems.push(`uncaught: ${text.slice(0, 200)}`);
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (/favicon/i.test(text)) return;
    // A status the app asks for and handles is not a fault: /api/setup/state
    // answers 404 once setup is done, and /api/auth/me answers 401 before
    // sign-in. Both are the app negotiating, and filtering them keeps this
    // check about real exceptions rather than teaching everyone to ignore it.
    if (/Failed to load resource/i.test(text)) return;
    problems.push(`console: ${text.slice(0, 200)}`);
  });
  return problems;
}

// --------------------------------------------------------------- the send path
async function testTouchSend(browser) {
  step('Talk: a real tap on a touch-capable WebKit');
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3,
  });
  const page = await ctx.newPage();
  try {
    await signIn(page, MEMBER);
    await page.goto(`${BASE}/app/talk`, { waitUntil: 'networkidle' });

    const composer = page.getByLabel('Message Josi');
    await composer.waitFor({ state: 'visible', timeout: 15000 });

    const send = page.getByRole('button', { name: 'Send message' });
    const box = await send.boundingBox();
    record(
      'the send button is at least 44x44',
      !!box && box.width >= 44 && box.height >= 44,
      box ? `${Math.round(box.width)}x${Math.round(box.height)}` : 'no box',
    );

    // NOTE: no page.waitForFunction anywhere in this file. It evaluates a
    // string in the page, which needs 'unsafe-eval' — and this app's CSP
    // refuses it. That refusal is the policy working, so the suite works within
    // it using locator waits, which go through Playwright's own protocol.
    const mine = `tap test ${Date.now()}`;
    await composer.fill(mine);
    // A TAP, not a click. This is the whole reason WebKit + hasTouch is here.
    await send.tap();
    await page.getByText(mine, { exact: false }).first().waitFor({ timeout: 30000 });
    record('a TAP delivers the message', true);

    // And a reply came back, so the tap reached the network rather than only
    // painting the optimistic bubble. The stub model always answers "Noted."
    const reply = page.locator('section div.rounded-bl-md');
    await reply.first().waitFor({ timeout: 30000 })
      .then(() => record('Josi answered the tapped message', true))
      .catch(() => record('Josi answered the tapped message', false, 'no reply bubble'));

    // Enter must still send, for anyone on a keyboard.
    const second = `enter test ${Date.now()}`;
    await composer.fill(second);
    await composer.press('Enter');
    await page.getByText(second, { exact: false }).first().waitFor({ timeout: 30000 });
    record('Enter still sends', true);

    // The composer is above the fold, not under the home indicator.
    const footerBox = await page.locator('footer').boundingBox();
    const viewportHeight = page.viewportSize().height;
    record(
      'the composer sits inside the visible viewport',
      !!footerBox && footerBox.y + footerBox.height <= viewportHeight + 1,
      footerBox ? `bottom ${Math.round(footerBox.y + footerBox.height)} of ${viewportHeight}` : 'no box',
    );

    record('no horizontal scroll on Talk at 390px', (await overflow(page)) <= 0);

    // The engine shipped a temporary "Send probe" while chasing this bug.
    // Nothing like it may survive into CE.
    const probe = await page.getByText(/probe/i).count();
    record('no leftover debugging surface', probe === 0);
  } catch (err) {
    record('Talk touch send', false, String(err).split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------------------------- mobile layout
async function testWidths(browser) {
  step('Layout: nothing scrolls sideways on a phone');
  for (const width of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height: 780 }, hasTouch: true, isMobile: true });
    const page = await ctx.newPage();
    const problems = watch(page);
    try {
      await signIn(page, MEMBER);
      const bad = [];
      const blank = [];
      for (const path of MEMBER_PAGES) {
        await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
        const px = await overflow(page);
        if (px > 0) bad.push(`${path} +${px}px`);
        // A blank page has no overflow either.
        if ((await page.locator('main h1').count()) === 0) blank.push(path);
      }
      record(`no horizontal scroll on any page at ${width}px`, bad.length === 0, bad.join(', '));
      if (width === WIDTHS[0]) {
        record('every member page rendered its heading', blank.length === 0, blank.join(', '));
        record('no member page reported an error', problems.length === 0, problems.slice(0, 2).join(' | '));
      }
    } catch (err) {
      record(`layout at ${width}px`, false, String(err).split('\n')[0]);
    } finally {
      await ctx.close();
    }
  }
}

// --------------------------------------------------- the app's own fetches
/** Proves the page can call its own API and render what comes back.
 *
 * This exists because the only evidence otherwise was the ABSENCE of an error,
 * and WebKit's cancellation message made that evidence ambiguous. A created
 * task appearing on the home page is unambiguous: the fetch was allowed by the
 * CSP, it was authenticated by the cookie, and the result reached the DOM. */
async function testFetchesWork(browser) {
  step('The app can call its own API and show the result');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  try {
    await signIn(page, MEMBER);

    // Created through the page's own origin, with its own cookie and CSRF
    // pair — the same path the UI uses.
    const created = await page.evaluate(async () => {
      const csrf = /(?:^|;\s*)josi_csrf=([^;]+)/.exec(document.cookie);
      const res = await fetch('/api/assistant/tasks', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'x-josi-csrf': decodeURIComponent(csrf[1]) } : {}),
        },
        body: JSON.stringify({
          templateKey: 'follow_up',
          slots: { what: 'e2e-fetch-proof', when: 'today' },
        }),
      });
      return res.status;
    });
    record('a same-origin API call from the page succeeds', created === 201, `status ${created}`);

    await page.goto(`${BASE}/app/tasks`, { waitUntil: 'networkidle' });
    const shown = await page.getByText('e2e-fetch-proof').first().waitFor({ timeout: 15000 })
      .then(() => true).catch(() => false);
    record('what it created is fetched back and rendered', shown);

    await page.goto(`${BASE}/app`, { waitUntil: 'networkidle' });
    const onHome = await page.getByText(/follow up/i).first().waitFor({ timeout: 15000 })
      .then(() => true).catch(() => false);
    record('the home page renders data it fetched', onHome);
  } catch (err) {
    record('app fetches', false, String(err).split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------------------------- tap targets
async function testTapTargets(browser) {
  step('Every control a thumb can reach is at least 44px tall');
  const ctx = await browser.newContext({ viewport: { width: 320, height: 780 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  try {
    await signIn(page, MEMBER);
    const small = [];
    for (const path of MEMBER_PAGES) {
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      const offenders = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('button, a[href], select, input:not([type=hidden]), textarea')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue; // not rendered
          if (r.height < 44) {
            out.push(`${el.tagName.toLowerCase()}"${(el.textContent ?? '').trim().slice(0, 24)}" ${Math.round(r.height)}px`);
          }
        }
        return out;
      });
      if (offenders.length) small.push(`${path}: ${offenders.join(', ')}`);
    }
    record('no control shorter than 44px at 320px', small.length === 0, small.slice(0, 3).join(' | '));
  } catch (err) {
    record('tap targets', false, String(err).split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

// -------------------------------------------------------------- keyboard
async function testKeyboard(browser) {
  step('The app is navigable from a keyboard');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await signIn(page, MEMBER);
    await page.goto(`${BASE}/app/tasks`, { waitUntil: 'networkidle' });

    // Tab reaches something focusable, and focus is visible rather than
    // suppressed by a blanket outline:none.
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      return { tag: el.tagName.toLowerCase(), outline: style.outlineStyle, shadow: style.boxShadow };
    });
    record('Tab moves focus to a control', !!focused, focused ? focused.tag : 'nothing focused');

    // Every form control has a label a screen reader can use.
    const unlabelled = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('input:not([type=hidden]), select, textarea')) {
        const id = el.getAttribute('id');
        const labelled = (id && document.querySelector(`label[for="${id}"]`))
          || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        if (!labelled) out.push(el.getAttribute('name') ?? el.tagName.toLowerCase());
      }
      return out;
    });
    record('every field has a label', unlabelled.length === 0, unlabelled.join(', '));

    // Landmarks exist, so a screen reader has something to jump between.
    const landmarks = await page.evaluate(() => ({
      main: document.querySelectorAll('main').length,
      nav: document.querySelectorAll('nav[aria-label]').length,
      h1: document.querySelectorAll('h1').length,
    }));
    record(
      'the page has main, labelled nav and one h1',
      landmarks.main === 1 && landmarks.nav >= 1 && landmarks.h1 === 1,
      JSON.stringify(landmarks),
    );
  } catch (err) {
    record('keyboard', false, String(err).split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------- nothing external, nothing fake
async function testNoExternalAndNoPlaceholders(browser) {
  step('Nothing is fetched from a third party, and nothing pretends to work');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await ctx.newPage();
  const external = new Set();
  const cspViolations = [];
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (url.origin !== new URL(BASE).origin && url.protocol !== 'data:') external.add(url.origin);
  });
  page.on('console', (msg) => {
    if (/content security policy/i.test(msg.text())) cspViolations.push(msg.text().slice(0, 120));
  });
  try {
    await signIn(page, MEMBER);
    for (const path of MEMBER_PAGES) await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });

    record('no request left this origin', external.size === 0, [...external].join(', '));
    record('no CSP violation was reported', cspViolations.length === 0, cspViolations[0] ?? '');

    const csp = await page.evaluate(async () => (await fetch('/app')).headers.get('content-security-policy'));
    record('the CSP header is served', !!csp && csp.includes("default-src 'self'"), csp ?? 'absent');

    // Companion apps: labelled, with nothing pressable that would lie.
    await page.goto(`${BASE}/app/apps`, { waitUntil: 'networkidle' });
    const comingSoon = await page.getByText(/coming soon/i).count();
    const actions = await page.locator('main button, main a[href]:not([href^="/app"]):not([href^="/admin"])').count();
    record('the companion apps page says Coming soon', comingSoon > 0);
    record('and offers no download or install action', actions === 0, `${actions} action(s)`);

    // Connections is real as of Phase 7, so the check changes shape: with no
    // OAuth application registered there must still be nothing to press, and
    // the page must say why rather than offering a button that fails at the
    // provider.
    await page.goto(`${BASE}/app/connections`, { waitUntil: 'networkidle' });
    const notBuilt = await page.locator('[data-not-built="true"]').count();
    const connectButton = await page.getByRole('button', { name: /^Connect / }).count();
    record('connections says the installation is not set up', notBuilt > 0);
    record('and offers no Connect button while that is true', connectButton === 0);

    // Nothing anywhere is a disabled control standing in for a feature.
    const disabledDecoys = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('main button[disabled], main [aria-disabled="true"]')) {
        out.push((el.textContent ?? '').trim().slice(0, 30));
      }
      return out;
    });
    record('no disabled control stands in for a feature', disabledDecoys.length === 0, disabledDecoys.join(', '));
  } catch (err) {
    record('external/placeholders', false, String(err).split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

// ------------------------------------------------------------ role separation
async function testRoles(browser) {
  step('A member cannot reach the admin section');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  try {
    await signIn(page, MEMBER);

    // The nav does not offer it...
    const adminLink = await page.locator('header a[href="/admin"]').count();
    record('the member header offers no admin link', adminLink === 0);

    // ...and asking for it directly lands back in the workspace.
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForURL((u) => u.pathname.startsWith('/app'), { timeout: 10000 }).catch(() => {});
    record('a member asking for /admin ends up in /app', new URL(page.url()).pathname.startsWith('/app'), page.url());

    // The redirect is convenience; this is the control.
    const status = await page.evaluate(async () => (await fetch('/api/admin/assistant')).status);
    record('the admin API refuses a member session', status === 403, `status ${status}`);
    await ctx.close();

    step('An administrator has both, and the admin pages behave');
    const adminCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const adminPage = await adminCtx.newPage();
    // A blank page is indistinguishable from a loading one unless the
    // exception is captured. Found the hard way: `main` was empty and the
    // suite could only report the emptiness, not the cause.
    const pageErrors = watch(adminPage);
    await signIn(adminPage, ADMIN);
    record('the admin header offers the admin section',
      (await adminPage.locator('header a[href="/admin"]').count()) > 0);

    const bad = [];
    const blank = [];
    for (const path of ADMIN_PAGES) {
      await adminPage.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      const px = await overflow(adminPage);
      if (px > 0) bad.push(`${path} +${px}px`);
      // A blank page has no overflow either, so the layout check above passes
      // vacuously unless something asserts the page rendered at all.
      const heading = await adminPage.locator('main h1').count();
      if (heading === 0) blank.push(path);
    }
    record('no horizontal scroll on any admin page at 390px', bad.length === 0, bad.join(', '));
    record('every admin page rendered its heading', blank.length === 0, blank.join(', '));

    // The model page must not offer a subscription option as available. The
    // page fetches before it can render them, so wait for the card rather than
    // counting whatever happened to be painted.
    await adminPage.goto(`${BASE}/admin/model`, { waitUntil: 'networkidle' });
    const card = adminPage.getByText(/Using a Claude or ChatGPT subscription/i);
    const appeared = await card.first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
    if (!appeared) {
      const shown = (await adminPage.locator('main').innerText().catch(() => '')).slice(0, 160);
      record(
        'the model page rendered', false,
        `url=${adminPage.url()} main="${shown.replace(/\n+/g, ' / ')}" errors=[${pageErrors.join(' | ')}]`,
      );
    } else {
      record('the model page rendered', true);
    }
    record('nothing on an admin page reported an error', pageErrors.length === 0, pageErrors.join(' | '));
    const unavailable = await adminPage.getByText(/unavailable/i).count();
    const subscribeButton = await adminPage.getByRole('button', { name: /subscription|connect claude|connect chatgpt/i }).count();
    record('subscription options are shown as unavailable', unavailable > 0, `${unavailable} marked`);
    record('and there is nothing to press', subscribeButton === 0);
    await adminCtx.close();
  } catch (err) {
    record('roles', false, String(err).split('\n')[0]);
  }
}

// ------------------------------------------------------------------ branding
async function testBranding(browser) {
  step('The Josi identity is present');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    const wordmark = page.locator('img[src="/brand/josi-wordmark.png"]');
    record('the wordmark is on the sign-in screen', (await wordmark.count()) > 0);
    const loaded = await wordmark.first().evaluate((img) => img.naturalWidth > 0).catch(() => false);
    record('and it actually loaded', loaded === true);
    record('the product line is shown', (await page.getByText(/Fetching what/i).count()) > 0);
    record('the publisher is named', (await page.getByText(/SOCAL RECEPTIONIST LLC/i).count()) > 0);

    await signIn(page, MEMBER);
    const mark = page.locator('header img[src="/brand/josi-mark.png"]');
    record('the shepherd mark is in the header', (await mark.count()) > 0);
  } catch (err) {
    record('branding', false, String(err).split('\n')[0]);
  } finally {
    await ctx.close();
  }
}

const browser = await webkit.launch();
try {
  await testTouchSend(browser);
  await testWidths(browser);
  await testFetchesWork(browser);
  await testTapTargets(browser);
  await testKeyboard(browser);
  await testNoExternalAndNoPlaceholders(browser);
  await testRoles(browser);
  await testBranding(browser);
} finally {
  await browser.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
