# Linux native release checkpoint

Candidate: `josi-ce-server-setup-0.1.78_linux.1-1-x86_64.pkg.tar.zst`

SHA-256: `a4967378c24fa9d929bc9c32ad87cdb44f5bfccc0134861aaaa0b00278f7f4f4`

Target: unsigned Blade/Arch Linux x86_64 acceptance build.

## Automated evidence

- TypeScript workspace typecheck.
- Focused Linux secret, path translation, scanner, and lifecycle tests.
- Exact payload inventory and architecture/dependency inventory.
- Offline payload verification with mutation detection.
- Disposable full lifecycle using the real bundled PostgreSQL migrations and
  all six bundled services.
- Offline speech smoke through Kokoro WAV generation, Silero VAD, and
  faster-whisper CPU transcription.

## Physical acceptance still required

Do not publish this build. On a disposable Blade/Arch x86_64 machine:

1. Verify the package checksum and inspect the package contents.
2. Install through the graphical setup application and Polkit prompt.
3. Finish browser setup, restart the machine, and verify all six services.
4. Exercise workspace selection, chat attachments, speech, and configured
   malware scanning.
5. Install a newer candidate and verify cold snapshot/upgrade behavior.
6. Inject a pre-activation failure and verify recovery without data loss.
7. Uninstall while retaining data, reinstall, and verify recovery.

Signing and public release require separate approval after physical acceptance.
