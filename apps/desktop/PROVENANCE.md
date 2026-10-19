# CE desktop source

Maintained in the CE workspace beginning with the unified build. Created and published by SOCAL RECEPTIONIST LLC under this repository's AGPL-3.0-or-later license.

The `direct-preload.cjs` and `local-workspace.cjs` modules originate in the verified desktop 0.6.5 corresponding source, with filenames adapted for this workspace. The upstream byte hashes and retained archive identity are recorded in [the source lock](../../docs/unified/desktop-source.lock.json). The folder broker additionally rechecks revocation and path identity after native approval and rejects linked recovery directories. The previous main process, hosted-product authentication/configuration, and other backend transports are not imported. The connection policy is rebuilt around the CE path with exact private-host checks and main-frame/origin binding.

The main process and recovery/connection page are new CE code. They preserve the existing direct preload's bounded native calls and selected-folder compatibility. Development launches use a fresh disposable data directory. Session cookies and folder grants are memory-only in this foundation; P2 must supply vault-managed credential projections before persistence is enabled. No production migration or installer replacement is claimed here.

Electron 43.2.0 is the pinned runtime already covered by the retained macOS distribution source lock and third-party notices. Use that verified runtime to run `apps/desktop`; do not silently download a different Electron version. This workspace deliberately does not duplicate its large runtime payload in npm dependencies. P5 connects this maintained source to the unified app/installer lifecycle.
