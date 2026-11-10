# Releasing the Josi server for Linux

The Linux server is headless. It runs under systemd as `josi.service`, keeps its
data in `/var/lib/josi` and its settings in `/etc/josi`, and does everything
else in the browser: first-run setup, sign-in with the authenticator code, chat
on the Ghost Stage, settings and one-click updates. Relay is off; people reach
it at `http://<machine-ip>:<port>`.

One command builds the release from a checkout:

```bash
scripts/linux/build-release.sh --version 1.1.4
```

Add `--skip-provision` when the pinned inputs were already built on this
machine, `--skip-code` when the server was just built, and `--publish` only
when the release should go to the shared GitHub release. The output lands in
`<build base>/releases/<version>/`:

- `josi_<version>_amd64.deb` and `josi-<version>-1-x86_64.pkg.tar.zst`: the
  server for Debian/Ubuntu and Arch, about 650 MB each. Inside: PostgreSQL,
  Node, the private Python with the speech packages and models, Caddy, the
  pinned Codex and Claude Code CLIs, and the Josi server and web app.
- `PKGBUILD`, `josi.install` and `josi-root-<version>-x86_64.tar.zst`: the same
  Arch package for `makepkg`.
- `linux`: the one-command installer, served as `https://<install host>/linux`.
- `linux-latest.json`: the feed the web updater reads. Attach it to the latest
  release so `releases/latest/download/linux-latest.json` finds it.
- `SHA256SUMS.txt` and `RELEASE-NOTES.md`.

## Installing, updating and removing

```bash
curl -fsSL https://<install host>/linux | sudo bash
# A minimal Debian (netinst) has no curl or sudo; as root this works too:
wget -qO- https://<install host>/linux | bash
```

First it asks, on the terminal, with the ghost in Plum & Gold:

1. **How people reach Josi:** this network only (`http://<LAN IP>:<port>`, the
   detected address prefilled), a public domain with HTTPS from the bundled
   Caddy (domain and certificate email; Caddy takes ports 80 and 443 and gets
   the certificate itself), or behind your own reverse proxy (its public
   `https://` address; point it at `http://<LAN IP>:<port>`).
2. **The port** (default 8080; a port in use is refused, with a free one offered).
3. **Let Josi control this computer?** If yes, Josi runs commands, works with
   files and starts programs as the Linux user you name (default: the user
   who ran sudo), through `josi-pc.service`.
4. A summary to confirm.

The answers are saved in `/etc/josi/install.json` and are the defaults the next
time. Nothing is asked with `--yes`, `JOSI_YES=1` or without a terminal; then
flags, the saved answers or the defaults are used, so automation works:

```bash
curl -fsSL https://<install host>/linux | sudo bash -s -- --yes \
  --address-mode lan|domain|proxy [--lan-address IP] [--domain NAME --email ADDRESS] \
  [--public-url https://HOST] --port 8080 [--pc-control-user USER | --no-pc-control]
```

The same flags work on `josi-ce-server-install` directly. Then the script finds
pacman or apt, installs what Josi needs, downloads the package for this
distribution and processor, checks its SHA-256 against itself, installs it,
enables `josi.service` and prints one line on stdout: the address to open
(the chosen one; for a domain or proxy it also names the LAN address on
stderr, for before DNS or the certificate is ready). Before setup is finished
that address carries a one-use handoff that expires after ten minutes, because
the setup page refuses visitors without one; running the command again prints
a fresh one. The same command also repairs a broken install, reinstalls after
an uninstall that kept the data, upgrades, and applies changed answers
(port, address, PC control on or off) to the running install.

The web service is started with `JOSI_LINUX_SERVER=1`, `APP_URL` (the chosen
address) and `JOSI_ACCESS_MODE`, so setup records that address and HTTPS mode
and shows the Address step instead of saving `localhost`; `/api/setup/state`
returns it as `installerAddress` for prefilling.

Interruptions: the script ignores a hangup (a dropped SSH session) and so do
dpkg and the lifecycle it starts; Ctrl-C stops the step, and the lifecycle
records the transaction as needing recovery. The next run first finishes dpkg
(`dpkg --configure -a`), rolls an interrupted upgrade back to its snapshot
(`maintenance.py recover`), and then installs again. Every `apt-get` waits up
to ten minutes for another apt (`DPkg::Lock::Timeout=600`). An install from
before the rename (`/var/lib/josi-ce-server`) is refused with the steps to
remove it.

- **Updates:** a root updater (`josi-update.timer`, twice a day) reads the feed
  in `/etc/josi/update.json`. Admin → Overview shows a new version, and System
  checkup has one **Update to X** button. The web service can only leave a
  request file in `data/state`; root checks the package hash, installs it,
  snapshots the data and moves it to the new version. A check and an update
  share one lock (`/var/lib/josi/update.lock`). If the update fails, the
  snapshot is put back (`josi-ce-server-install --recover`) before the old
  version starts again. Prereleases are packaged as `1.2.8~beta.1` so dpkg
  sees the release `1.2.8` as an upgrade.
- **Remove:** `sudo josi-uninstall` keeps `/var/lib/josi`;
  `sudo josi-uninstall --purge` deletes it, `/etc/josi`, `/var/lib/josi-pc`
  and Josi's accounts. Both remove `josi-pc.service` and the `josi-pc` group.
  `apt remove josi` stops and disables every Josi unit.

## Layout on the machine

| Path | What |
|---|---|
| `josi.service` | the unit to start, stop and enable; the six isolated services below are `PartOf` it |
| `josi-ce-{database,voice,voice-control,web,worker,proxy}.service` | one system account each; restart on failure. The web unit is also in group `josi-pc`; the proxy may bind 80 and 443 |
| `josi-pc.service` | only with PC control: `packaging/linux/pc-executor/josi-pc.mjs` on the current version's Node, as the chosen user (no ProtectHome/ProtectSystem), state in `/var/lib/josi-pc`, `PartOf=josi.service` |
| `/usr/lib/josi/josi-browser-host` and `com.heyjosi.browser.json` in the Chrome/Brave, Chromium, Edge and Firefox system native-messaging folders | only with PC control: the browser host, made by `pc-executor/browser.mjs` and rewritten for the current version on every install and upgrade |
| `/var/lib/josi/data/pc-spool` | `root:josi-pc 2770`: where the web service and the executor meet |
| `/etc/josi/install.json` | the installer's answers (address mode, address, port, PC control user) |
| `josi-update.path`, `josi-update.service`, `josi-update.timer`, `josi-update-check.service` | the root updater |
| `/usr/lib/josi` | the package: runtime, inventory, `josi_update.py` |
| `/var/lib/josi/versions/<version>` | the verified program each version runs from |
| `/var/lib/josi/data` | database, secrets, settings, uploads, the CLIs' sign-ins |
| `/etc/josi` | `update.json`, `README` and a link to `data/config/runtime.json` |

## The build machine

An x86_64 Linux machine with Docker, Node, npm, Python 3 and `zstd`. Native
parts are compiled inside a digest-pinned Debian 12 image (glibc 2.34+).

| Variable | Default | Holds |
|---|---|---|
| `JOSI_LINUX_BUILD_BASE` | `~/JosiDrive/BuildTemp/josi-ce-native-linux-20261010` | compiled PostgreSQL and Python, staged runtime, package roots, `artifacts/`, `releases/` |
| `JOSI_LINUX_BUILD_CACHE` | `~/JosiDrive/Caches/codex-linux-native-20261010` | pinned downloads, including `subscription-cli/` |
| `JOSI_INSTALLER_BASE_URL` | the GitHub release download folder | where the installer downloads packages |
| `JOSI_UPDATE_FEED_URL` | `.../releases/latest/download/linux-latest.json` | the feed baked into `/etc/josi/update.json` on first install |

For a LAN test, point both URLs at a local web server (`http://` is allowed
only when the feed itself is `http://`).

## Checks before publishing

- `python3 -m unittest discover -s packaging/linux -p 'test_*.py'` on the build machine.
- `scripts/linux/e2e-fake.mjs` on an installed test machine: first-run setup
  with a generated test account, password plus authenticator login, a fake
  OpenAI-compatible model with the tool check, a chat turn with a real Josi
  tool call, and both bundled CLIs driven through Josi's providers against the
  fake backend. `scripts/linux/e2e-screens.mjs <dir> [--update]` then signs in
  through the browser, chats on the Ghost Stage, takes screenshots and can
  press the one-click update. Both run on the machine itself, on loopback.

## Known gaps

- x86_64 only. arm64 needs an arm64 private Python, PostgreSQL and speech
  build and arm64 pins for Python and OpenBLAS; Node, Caddy and both CLIs are
  already pinned for arm64, and the installer and updater already pick an
  aarch64 package when one is listed.
- The packages are not signed with a distribution key; the installer verifies
  them by SHA-256 and should be served over HTTPS.
- Old program versions in `/var/lib/josi/versions` and upgrade snapshots in
  `/var/lib/josi/transactions` are kept and not yet pruned.
- No passkeys or Face ID on a plain `http://` address; browsers allow them only
  over HTTPS (choose the domain or proxy answer for them).
- The setup Address step is shown on Linux and the server returns the chosen
  address as `installerAddress`, but `apps/web/src/pages/Setup.tsx` does not
  yet use it to prefill its fields.
- A domain answer keeps the LAN port open over plain HTTP as well.
- The optional desktop helpers for PC control (xdotool, wmctrl, scrot) are
  installed only when the machine boots to a graphical target or has an X11
  or Wayland session.
- The graphical AppImage installer (`--portable`) and `build-rpm.py` belong to
  the earlier desktop-setup layout and were not updated.
