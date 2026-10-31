# Native Linux server

This port runs Josi CE Server directly on Linux without Docker. The x86_64
acceptance formats are Pacman, Debian, and RPM packages.

## Runtime

- Six least-privilege systemd services: database, voice, voice control, web,
  worker, and loopback proxy.
- Bundled Node.js, PostgreSQL, Python, Caddy, CPU speech runtime, and locked
  offline speech models.
- All listeners bind to `127.0.0.1`. The browser entry point is
  `http://127.0.0.1:8080`.
- Application data lives at `/var/lib/josi-ce-server`; immutable versioned
  runtimes live below `/var/lib/josi-ce-server/versions`.
- Linux secrets are read from descriptor-pinned, root-protected files. Symlinks,
  hard links, broad modes, and extended ACLs are rejected.

## Lifecycle guarantees

The privileged helper has one fixed install operation and starts a bundled
Python entry point with an empty environment. Installation verifies every
payload hash before mutation, records hash-chained durable transaction phases,
stops services before snapshotting, runs migrations before activation, and
commits only after database, web, worker, proxy, and speech readiness checks.

A failed upgrade retains the old data, candidate, snapshot, logs, and journal.
Automatic rollback is allowed only before candidate activation. Once activation
has begun, recovery stops for review so newer user writes are not discarded.

## Malware scanning

No scanner is bundled or required. Since the 1.0 merge the native Linux
package behaves like the native Mac package: uploads, indexing and OCR use the
bundled parsers, and a legacy ClamAV flag carried over by an upgrade is
ignored (`scanRequired` in `packages/storage/src/gates.ts`). The earlier
fail-closed `clamd` socket requirement was removed together with its macOS
counterpart on the owner's decision of 15 October 2026.

## Portability baseline

Native components are built in a digest-pinned Debian 12 environment. The
payload's highest required glibc symbol is `GLIBC_2.34`, covering the current
acceptance targets: Blade/Arch, Debian 12+, Ubuntu 22.04+, and RHEL 9+/Fedora.
All package formats carry the same inventory-verified runtime.

## Current scope

The packages are unsigned x86_64 builds. Package signatures and arm64 builds
remain open. The release build and its order are in
[LINUX_RELEASE.md](../LINUX_RELEASE.md).
