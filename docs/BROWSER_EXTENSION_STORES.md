# Publishing the Josi browser extension

"Josi Browser Control" lets Josi, the assistant app on the same computer, use
your web browser: the tab you are looking at, any open tab, or a page Josi
opens (starting the browser if it is closed), always within your permissions
in Josi's PC Control. Three stores cover four browsers: the **Chrome Web
Store** (Chrome and Brave; Brave has no store of its own), **Microsoft Edge
Add-ons** and **Firefox Add-ons (AMO)**. Signing in, paying fees and pressing
Submit are the owner's; everything else is prepared here.

## What is ready (version 1.0.0)

| Item | Where |
|---|---|
| Store packages | `C:\Dev\josi-extensions\1.0.0\store\josi-browser-control-{chrome,edge,firefox}-1.0.0.zip` (rebuild: `node scripts/unified/build-browser-extensions.mjs <new empty folder>`) |
| Icon 128×128 | `apps/browser-extension/store/icon-128.png` |
| Edge logo 300×300 | `apps/browser-extension/store/edge-logo-300.png` |
| Chrome small promo tile 440×280 | `apps/browser-extension/store/promo-tile-440x280.png` |
| Screenshots 1280×800 | `apps/browser-extension/store/screenshot-1-uses-your-browser.png`, `screenshot-2-you-stay-in-charge.png` (re-render: `node scripts/unified/make-store-screenshots.mjs <repo> apps/browser-extension/store`) |
| Privacy policy URL | https://heyjosi.com/browser-extension/privacy/ (text: `docs/BROWSER_EXTENSION_PRIVACY.md`) |
| Homepage / support | https://heyjosi.com, help site https://help.heyjosi.com, support@heyjosi.com |

The Firefox package passes Mozilla's `web-ext lint` with no errors, warnings or
notices. Every store refuses a version it has already seen: raise `VERSION` in
the build script before each new submission.

## Listing text (paste as is)

**Name**: Josi Browser Control

**Short description / summary** (124 characters, same as the manifest):
Lets the Josi app on your computer use your browser, only with your permissions. Never touches passwords or payment details.

**Category**: Productivity (Chrome: "Productivity > Workflow & Planning"; Edge: "Productivity"; Firefox: "Other" and "Tabs").

**Long description**:

> Josi Browser Control connects your browser to Josi, the assistant app on your computer, so Josi can do things on the web for you.
>
> Ask in Josi's chat and it happens in your browser:
> • "What's on this page?": Josi reads the tab you are looking at.
> • "Open mercari.com": Josi opens it in a new tab, and starts your browser if it is closed.
> • "Describe each photo": Josi looks at pictures on the page, one at a time.
> • Fill in fields, choose options, click, scroll, download and upload files, when you allow it.
>
> You stay in charge:
> • Every site and action follows the permissions you set in Josi's PC Control, or Josi asks you in chat first.
> • It never reads or fills passwords, payment details or one-time codes.
> • "Take control" in the popup stops Josi in this browser at once; Pause and Stop in Josi stop everything.
> • No servers of its own and no ads. Page content goes only to the Josi app on your computer, which you run.
>
> Requires the Josi app (heyjosi.com) installed and open on the same computer. Works in Chrome, Edge, Brave and Firefox.

**Single purpose** (Chrome asks): Lets the Josi assistant app on the same computer read and act on web pages in this browser when the user asks, within the user's Josi permissions.

**Permission justifications** (Chrome asks for each; Edge and AMO reviewers read them too):

| Permission | Why |
|---|---|
| `nativeMessaging` | Talks to the Josi app on the same computer; nothing else. |
| `tabs` | Knows which tab the user is looking at, and the site and title of open tabs so the user can say "go to my Gmail tab" in Josi. |
| `activeTab` | Acts on the tab the user is looking at when they ask Josi. |
| `scripting` | Reads the page and performs the requested action (fill, click, choose, scroll, upload) in the tab Josi uses. |
| `storage` | Remembers this browser's random id and, until the browser closes, which tab Josi is using. |
| `alarms` | Reconnects to the Josi app every 30 seconds while the browser is open, so it works again after Josi restarts. |
| `downloads` | Saves a file from the site in use into the Downloads folder when the user asks Josi and allows it. |
| Host permissions `https://*/*` and `http://*/*` | Josi opens or reads whichever site the user names in chat; asking per site at install time is not possible for sites named later. Every site and action is still allowed or approved by the user in Josi before anything is read or done. |

**Remote code**: No. All code is in the package.

**Data use** (Chrome privacy tab): collects "Website content" (only when the user asks Josi; sent only to the Josi app on the same computer); does not sell data; does not use it for unrelated purposes or creditworthiness. Firefox: the manifest already declares `websiteContent`, `websiteActivity` and `browsingActivity` in `data_collection_permissions`.

**Notes for reviewers** (Edge certification notes, AMO "notes to reviewer", Chrome test instructions):
Requires the Josi desktop app (free, https://heyjosi.com) on the same computer; the extension talks only to that app over native messaging and has no servers. Without the app, the popup says "Josi is not open on this computer". Passwords, payment and one-time-code fields are excluded in page-agent.js (`sensitive()`).

## Chrome Web Store (Chrome and Brave)

1. Sign in at https://chrome.google.com/webstore/devconsole with the Google
   account that will own the listing (one-time 5 USD registration). Use the
   publisher name SOCAL RECEPTIONIST LLC and verify the contact email.
2. "New item", upload `josi-browser-control-chrome-1.0.0.zip`.
3. Store listing: text above, icon, the two screenshots, the 440×280 tile; support URL `https://help.heyjosi.com` (Chrome refuses `mailto:`). Set and verify the publisher contact email under Settings first.
   Privacy: single purpose, the permission table, "no remote code", data use,
   privacy policy URL. Distribution: "Unlisted" first if you want to try the
   store copy before the public; "Public" otherwise.
4. Submit. "Access to all sites" means an in-depth review: expect days, maybe
   a couple of weeks the first time.
5. Brave: nothing to submit. Brave users install the Chrome Web Store listing
   ("Add to Brave").

## Microsoft Edge Add-ons

1. Sign in at https://partner.microsoft.com/dashboard/microsoftedge (free).
2. "Create new extension", upload `josi-browser-control-edge-1.0.0.zip`.
3. Availability (public or hidden), properties (Productivity, privacy policy
   URL, website, support email), listing (text above, `edge-logo-300.png`,
   screenshots), certification notes (above).
4. Submit; the first review takes about a week.

## Firefox Add-ons (AMO)

1. Sign in at https://addons.mozilla.org/developers/ (free).
2. "Submit a New Add-on", "On this site", upload
   `josi-browser-control-firefox-1.0.0.zip`. The add-on ID
   `josi-browser@heyjosi.com` is in the manifest; never change it (the Josi app
   already knows it, and Mozilla ties the listing to it).
3. Source code: answer "no" (no build step, no minification).
4. Listing text above, categories, support, privacy policy URL, reviewer notes.
5. Submit. Automatic checks run at once (the same linter passes locally); the
   listing goes live after them, with a human review later.

## After approval: connect the store IDs to the Josi app

The Josi app answers only extension IDs it knows. Firefox keeps the fixed ID
above, so it works at once. Chrome and Edge assign their own IDs:

1. Copy each ID from the store dashboard (32 letters a to p).
2. Add both to `StoreExtensionIds` in `apps/windows-native/src/BrowserHost.cs`
   and to `chromiumStoreIds` in `apps/browser-extension/development-identity.json`.
3. Build and ship a Josi installer. Until it is installed, an existing Josi can
   be told the IDs without a rebuild: a JSON array of the IDs in
   `%LOCALAPPDATA%\Josi\BrowserHost\extension-ids.json`, then restart Josi.
4. Only then switch the listings to Public (or announce them), so nobody
   installs a store copy that Josi does not yet answer.

The unpacked development builds (fixed development ID) keep working beside the
store copies, so testing never disturbs an installed store version.

## Safari

Safari extensions ship inside a macOS app: `xcrun safari-web-extension-converter`
on the build's `safari/` folder, inside the Mac app, with an Apple Developer
account. See `docs/MACOS_PARITY_HANDOFF_2026-11-09.md`.
