# Linux native release checkpoint

Candidates:

- `josi-ce-server-setup-0.1.78_linux.2-1-x86_64.pkg.tar.zst`
  - SHA-256: `253b473c0e8247a6388c56ace2c182840c021c826abef857878b3552a4cfabac`
- `josi-ce-server-setup_0.1.78-linux.2_amd64.deb`
  - SHA-256: `579497c809e3b6c9b4ca954f95b61b588da6146a46f253854a655b19ab6938ed`
- `josi-ce-server-setup-0.1.78-linux.2.x86_64.rpm`
  - SHA-256: `7804101aa0a5bf2fa16f3df369f720e7a3a45b68218dbe56ad5c279d9c39719f`

Checksums are recorded in the artifact directory's `SHA256SUMS.txt`.

Target: unsigned x86_64 acceptance builds for Blade/Arch, Debian 12+ and
Ubuntu 22.04+, and RHEL 9+/Fedora.

## Automated evidence

- TypeScript workspace typecheck.
- Focused Linux secret, path translation, scanner, and lifecycle tests.
- Exact payload inventory and architecture/dependency inventory.
- Digest-pinned Debian 12 native build with a verified `GLIBC_2.34` ceiling.
- Byte-for-byte reproducible Pacman, Debian, and RPM package rebuilds.
- Identical runtime payloads extracted from all three package formats.
- Offline payload verification with mutation detection.
- Disposable full lifecycle using the real bundled PostgreSQL migrations and
  all six bundled services.
- Full extracted-package lifecycle inside the Debian 12 baseline container.
- Offline speech smoke through Kokoro WAV generation, Silero VAD, and
  faster-whisper CPU transcription.

## Physical acceptance still required

Do not publish these builds. Repeat the checklist on disposable Blade/Arch,
Debian/Ubuntu, and RHEL/Fedora x86_64 machines:

1. Verify the package checksum and inspect the package contents.
2. Install through the graphical setup application and Polkit prompt.
3. Finish browser setup, restart the machine, and verify all six services.
4. Exercise workspace selection, chat attachments, speech, and configured
   malware scanning.
5. Install a newer candidate and verify cold snapshot/upgrade behavior.
6. Inject a pre-activation failure and verify recovery without data loss.
7. Uninstall while retaining data, reinstall, and verify recovery.

Signing and public release require separate approval after physical acceptance.
