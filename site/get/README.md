# get.heyjosi.com

The download page. Static: `index.html`, `releases.js` (reads the GitHub
Releases of vaxman14/josi-ce and fills in versions, sizes and links), the
Josi mark, `fonts/` (the same files as `apps/web/public/fonts`), `_redirects` (the Linux `install.sh` points at the newest server
release's `install-josi-ce-server.sh`) and `_headers`.

Hosted on Netlify (project `josi-get`, team CTFDesigns) with the custom
domain get.heyjosi.com behind Cloudflare. Deploy this folder as is; no build.

Cloudflare keeps `releases.js` and images for up to four hours, whatever
`_headers` says. The page itself is not kept, so bump `?v=` in `index.html`
when one of those changes.

Publishing a release is the only step that changes what the page offers:

- Server and app installers go in a release tagged `v<version>` with assets
  named `Josi-CE-<version>-Windows-x64.exe`, `Josi-CE-<version>-macOS*.dmg`
  (or `.pkg`), `install-josi-ce-server.sh` plus Linux packages, and
  `SHA256SUMS.txt`.
- Desktop client apps (a PC that connects to a server elsewhere) go in a
  release tagged `desktop-v<version>`.
- After publishing a server release, move the tag in `_redirects` and deploy
  this folder. The page finds new releases by itself; `/install.sh` does not.
- Drafts are never shown. Pre-releases show only where no final release has
  that platform's file, marked "preview".
