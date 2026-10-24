# Publishing the Josi browser extension

The extension ("Josi Browser Control") lets Josi use one tab you attach in
your own browser, through the Josi app on the same computer. This page is the
step list for putting it in the browser stores, written for the person who
owns the publisher accounts. Nothing here is automated: every store asks a
human to sign in, pay once and press Submit.

## Build the packages

From the repository, with the packages built (`npm run build`):

```bash
node scripts/unified/build-browser-extensions.mjs C:\Dev\josi-extensions\2026-10-24
```

The folder gets:

- `chrome/`, `brave/`, `edge/`, `firefox/`, `safari/`: unpacked development
  builds with the fixed development identity (the extension ID never changes
  between loads).
- `store/josi-browser-control-chrome-0.8.0.zip`: the Chrome Web Store package
  (Brave users install it from there).
- `store/josi-browser-control-edge-0.8.0.zip`: the Microsoft Edge Add-ons package.
- `store/josi-browser-control-firefox-0.8.0.zip`: the Firefox Add-ons package.
- `BrowserExtensionCatalog.json`: every file's SHA-256, per package.

The version is set once in the build script (`VERSION`). Every store rejects a
re-upload with a version it has already seen, so raise it before each submission.

## What every store asks for

Prepare these once; the same material serves all three listings.

- **Name**: Josi Browser Control.
- **Short description** (under 132 characters): Let your Josi assistant use one
  tab you attach in this browser, with the permissions you gave it in Josi.
- **Long description**: what it does (controls only the tab you attach, only
  through the Josi app installed on this computer, only within the permissions
  set in Josi), what it never does (no browsing history, no other tabs, no
  servers of its own: it talks to the Josi app on this computer over the
  browser's native messaging), and that a running Josi app is required.
- **Icon**: `apps/browser-extension/src/icons/icon-128.png` (derived from the
  Josi mark); the stores also want 300×300 (Edge) and 1400×560 or 440×280
  promotional tiles (Chrome, optional).
- **Screenshots**: at least one, 1280×800 or 640×400 (Chrome and Edge), any
  reasonable size for Firefox. Show the popup with "Attach this tab" and a Josi
  chat using the page.
- **Privacy policy URL**: a page on heyjosi.com that says the extension sends
  page content only to the Josi app on the same computer, nowhere else, and
  stores only the attached tab's identifier locally. The stores require a URL;
  the repository's `docs/PRIVACY_NOTICE.md` is the text to publish.
- **Permission justifications** (Chrome asks for each): `nativeMessaging`
  (talks to the Josi app), `activeTab` and `tabs` (the one tab you attach),
  `scripting` (reads and acts on that tab), `storage` (remembers the attached
  tab), `alarms` (re-attaches after the Josi app restarts), optional host
  permissions (only the site of the attached tab, asked when you attach it).
- **Support email** and a **homepage** (heyjosi.com).

## Chrome Web Store (Chrome and Brave)

1. Sign in at https://chrome.google.com/webstore/devconsole with the Google
   account that will own the listing. One-time developer registration fee: 5 USD.
2. "New item", upload `store/josi-browser-control-chrome-0.8.0.zip`.
3. Fill the store listing (text, icon, screenshots), the privacy tab (policy
   URL, the permission justifications, "no remote code", data use: page content
   is processed locally), and distribution (public, all regions, or unlisted
   while testing).
4. Submit for review. First reviews take days; later updates are usually hours.
5. After approval the store assigns the public extension ID. Put it into
   `apps/windows-native/src/BrowserHost.cs` (`ExtensionId`) and in
   `development-identity.json` (`chromiumId`), rebuild the app, and ship it:
   the Josi app only answers the extension IDs it knows. Until then the store
   build cannot connect to the app, by design.
6. Brave: nothing to do. Brave installs extensions from the Chrome Web Store.

## Microsoft Edge Add-ons

1. Sign in at https://partner.microsoft.com/dashboard/microsoftedge with a
   Microsoft account. Registration is free.
2. "Create new extension", upload `store/josi-browser-control-edge-0.8.0.zip`.
3. Fill availability (public or hidden), properties (category: Productivity,
   privacy policy URL, support contact), listing (text, 300×300 logo,
   screenshots), and notes for certification: "Requires the Josi app on the
   same computer; without it the popup only says so."
4. Submit. Edge reviews take about a week the first time.
5. After approval, add the Edge extension ID to the app the same way as the
   Chrome one (the app accepts several IDs). Until then, Edge users can load the
   unpacked `edge/` folder: edge://extensions, Developer mode, Load unpacked.

## Firefox Add-ons (AMO)

1. Sign in at https://addons.mozilla.org/developers/ with a Firefox account.
   Free.
2. "Submit a New Add-on", "On this site", upload
   `store/josi-browser-control-firefox-0.8.0.zip`. The manifest already carries
   the fixed add-on ID (`josi-browser@heyjosi.com`); do not change it after the
   first upload, Mozilla ties the listing to it.
3. Firefox does not need source code for this extension (it has no build step
   or minification), so answer "no" to the source question.
4. Fill the listing, categories, support, privacy policy URL, and the data
   collection disclosure (the manifest declares website content and activity
   for the attached tab).
5. Submit. AMO runs automatic checks at once and a human review later; the
   listing goes live after the automatic checks pass.
6. The Josi app already knows the Firefox add-on ID, so no app change is needed
   for Firefox. Until the listing is live, Firefox can load the `firefox/`
   folder temporarily: about:debugging, This Firefox, Load Temporary Add-on,
   pick its `manifest.json` (it is forgotten when Firefox closes).

## Safari

Safari extensions ship inside a macOS app from the App Store. Xcode's
`xcrun safari-web-extension-converter safari/` turns the `safari/` folder into
that app; it needs a Mac, an Apple Developer account (99 USD a year) and
notarization. This is the macOS app's release, not the Windows build's.

## After publishing

- Keep the one-time keys and accounts in the company password manager.
- When the app's `ExtensionId` list changes, rebuild and ship the Windows app
  first; the store listing can go public afterwards.
- The unpacked development builds keep working beside the store builds (they
  have their own fixed ID), so testing a new version never disturbs an
  installed store copy.
