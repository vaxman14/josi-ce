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
```

The script finds pacman or apt, installs what Josi needs, downloads the package
for this distribution and processor, checks its SHA-256 against itself,
installs it, enables `josi.service` and prints one line: the address to open.
Before setup is finished that address carries a one-use handoff that expires
after ten minutes, because the setup page refuses visitors without one; running
the command again prints a fresh one. The same command also repairs a broken
install, reinstalls after an uninstall that kept the data, and upgrades.

- **Updates:** a root updater (`josi-update.timer`, twice a day) reads the feed
  in `/etc/josi/update.json`. Admin → Overview shows a new version, and System
  checkup has one **Update to X** button. The web service can only leave a
  request file in `data/state`; root checks the package hash, installs it,
  snapshots the data and moves it to the new version.
- **Remove:** `sudo josi-uninstall` keeps `/var/lib/josi`;
  `sudo josi-uninstall --purge` deletes it, `/etc/josi` and Josi's accounts.

## Layout on the machine

| Path | What |
|---|---|
| `josi.service` | the unit to start, stop and enable; the six isolated services below are `PartOf` it |
| `josi-ce-{database,voice,voice-control,web,worker,proxy}.service` | one system account each; restart on failure |
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
  over HTTPS.
- The graphical AppImage installer (`--portable`) and `build-rpm.py` belong to
  the earlier desktop-setup layout and were not updated.
