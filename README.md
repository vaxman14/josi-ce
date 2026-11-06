# Josi CE

**Your assistant, on a computer you own.**

Josi CE is a personal AI assistant that runs on your own PC, Mac, Linux box
or NAS, and that you use from your phone, your browser and your other
computers. It thinks with an AI account you already have, a ChatGPT or Claude
plan or an API key, and keeps your conversations, your memory and your
connected accounts on your disk. It is free, and the source is here.

Made by SOCAL RECEPTIONIST LLC.

## Get it

**[get.heyjosi.com](https://get.heyjosi.com)** has the installer for your
computer and the three steps that follow. The same files are on the
[releases page](https://github.com/vaxman14/josi-ce/releases).

- **Windows**: one installer with the server and the app. The PC you sit at
  can be the server.
- **Mac**: one installer with the server and the app.
- **Linux and NAS**: one script, or a Debian, Fedora or Arch package.
- **Phone**: the Josi CE app on the
  [App Store](https://apps.apple.com/us/app/josi-ce/id6810549193) and
  [Google Play](https://play.google.com/store/apps/details?id=com.socalreceptionist.josice),
  or Josi's address in the phone's browser.

Help pages: [help.heyjosi.com](https://help.heyjosi.com). Questions and bugs:
[issues](https://github.com/vaxman14/josi-ce/issues).

## What it does

- **Talks and does.** Chat by text or voice; Josi reads your mail, calendar
  and contacts when you connect them, works in your folders, and uses one
  browser tab you attach and the programs on your PC, with your permission
  for each.
- **Remembers.** A memory of your conversations and the facts you tell it,
  yours to see and to correct.
- **Keeps people apart.** Everyone in the house or the office gets their own
  account on the one server and sees only their own things. The owner sets
  what Josi may do for whom.
- **Protects the serious changes.** Rules you mark as protected need a
  Windows Hello or Touch ID approval on an enrolled device before they change.
- **Backs itself up.** One file with everything, encrypted if you want, that
  restores on a fresh install.

## Reach it from anywhere (optional)

Josi CE is free and complete on its own. With a free Hey Josi account you can add
a plan that gives your server its own address, like `alice.heyjosi.com`. It works
behind any router, with no port forwarding.

| Plan | Price | What you get |
|---|---|---|
| Free | $0 | All of Josi CE, with your own AI key. No relay needed. |
| Connect | about $8/mo | The relay, your address, and Google sign-in with no Google setup. |
| Connect + AI | about $20/mo | Connect, plus AI included up to a monthly allowance. |

Sign up at [heyjosi.com](https://heyjosi.com), install the server, and paste the
link code from your account page into **Hey Josi** on your server. Then pair each
phone, computer or browser under **Devices**, with a QR code or a one-time code.

Everything between your devices and your server is encrypted end to end. The
relay passes sealed messages and can't read or change them. Your account can't
open your server, and you still sign in to Josi itself. The limits are spelled
out in [what the relay can and can't see](docs/RELAY_PRIVACY.md), including the
two places traffic does touch us: Hey Josi AI, and Google sign-in.

On your own network, devices connect straight to your server. You can also
[run your own relay](docs/SELF_HOSTED_RELAY.md), or use none.

## What Josi CE is not

- Not a hosted assistant. Your conversations, memory and connected accounts stay
  on your server. The optional account holds only what's listed in
  [the privacy page](docs/RELAY_PRIVACY.md).
- Not multi-tenant. One server is one household or one office.

## For developers

The repository holds the server (`apps/api`, `apps/worker`, `packages/*`),
the web app (`apps/web`), the Windows app (`apps/windows-native`), the
macOS app and installer (`packaging/macos`), the Windows installer and
release script (`packaging/windows`, `scripts/windows`), the browser
extension (`apps/browser-extension`) and the help site (`docs-site`). The hosted
side is here too: the relay (`services/relay`), the encrypted tunnel used by
everything (`packages/tunnel`), and accounts, billing and the AI gateway
(`apps/hosted`).

- Build and run: [docs/HELP.md](docs/HELP.md) and
  [docs/INSTALLATION.md](docs/INSTALLATION.md).
- The relay and accounts: [protocol](docs/RELAY_PROTOCOL.md),
  [privacy](docs/RELAY_PRIVACY.md), [plans](docs/PLANS.md),
  [setting up the hosted side](docs/HOSTED_SETUP.md).
- Releases: [Windows](docs/WINDOWS_RELEASE.md), [Mac](docs/MACOS_RELEASE.md),
  [Linux](docs/LINUX_RELEASE.md). All three attach to one GitHub release per
  version (`v1.0.0`), which is what the download page reads.
- Browser extension stores:
  [docs/BROWSER_EXTENSION_STORES.md](docs/BROWSER_EXTENSION_STORES.md).
- Design, decisions, threat model and the rest: the [docs](docs) folder.

Contributions: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports:
[SECURITY.md](SECURITY.md).

## Licence

Josi CE is published under the licence in [LICENSE](LICENSE), with the
notices in [NOTICE](NOTICE). "Josi" is a trademark of SOCAL RECEPTIONIST LLC;
see [TRADEMARK.md](TRADEMARK.md). If you fork Josi CE, you may remove its
branding, and must not present the fork as the official product. Terms, privacy
and support policies:
[docs/LEGAL.md](docs/LEGAL.md).
