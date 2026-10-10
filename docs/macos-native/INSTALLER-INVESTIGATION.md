# Installer investigation — 2026-10-10

This is a blocked diagnostic checkpoint, **not a physical-acceptance candidate**.
Branch: `macos/native-distribution-20261009`; baseline: `860bd5a`.

## Failed physical verification

Roman confirmed that the failed physical test selected **Verify package**.
The privileged Install path never began. No installation diagnostic was
preserved and no `josi-setup-<uuid>.jsonl` was created. `Setup.swift` captured
the verifier's merged stdout/stderr and discarded it, including launch errors.
`lifecycle.py` further reduced the actual exception to its class name.
Those are the confirmed causes of missing diagnostic evidence; the original
verifier failure's underlying cause cannot be recovered from that evidence.

Read-only verification of the preserved accepted app at
`socal-signed-20261010T021606Z/Josi CE Server Setup.app` succeeded in this session:

```json
{"verified":"ea12a8b73f12c0a7a0cf57cef677dc78353878dece00c3cc05856a25016121f6","architecture":"arm64"}
```

The base artifact directory is
`/Volumes/JosiOS/JosiDrive/Artifacts/josi-ce-native-macos-arm64-20261009/`.
The current read-only result does not reproduce the original failure and is
not evidence of installation success. The accepted app's Info.plist also
has no CFBundleIconFile; its source exposes competing Verify/Install/Open
actions and enables Open before installation.

## Diagnostic repair

Both UI operations now create a unique private diagnostic file before starting
the process. Failure to create durable diagnostics prevents the operation.
Complete output lines are redacted, retained, and flushed with fsync as they
arrive; process exit and launch errors are recorded. The UI exposes a selectable
log path and Copy diagnostic log path. Verification and installation outcomes
are distinct. Installation failure disables install/open actions; successful
verification alone cannot enable Open. The privileged helper's captured output
is copied into the user diagnostic log when it is available.

Normal installed-product diagnostic destination:
`~/Library/Logs/Josi CE Server/Setup/`. These files are not created by building
or testing the installer on this Mac. Isolated test output stays on JosiDrive.

Lifecycle failures retain a private durable `failure-diagnostics` file in the
transaction directory, including component, exit code, and redacted stdout and
stderr. CLI failure JSON includes the cause; hash failures identify the member.
Command arguments are omitted. Redirected phase/failure output is fsynced.
Existing migration, activation, recovery, and data-retention gates remain.

## Verification and limitations

- Python lifecycle suite: 11 passed (including two new diagnostic regressions).
- Swift diagnostic tests: durability/readback, cause retention, redaction,
  0600 permissions, and linked-folder refusal passed.
- Existing Swift progress executable: 7 assertions passed.
- AppKit source compile-check: arm64, full Xcode, macOS 14 target; executable
  was not run. New diagnostic sources compiled independently.
- Read-only accepted runtime integrity verification: passed as shown above.
- `git diff --check`: passed.
- Browser handoff executable was mistakenly invoked without its required
  disposable-server fixture argument and aborted with Index out of range.
  This is an invocation error, not a handoff product-test result. No handoff
  acceptance is claimed in this checkpoint.

No new complete package, desktop/workspace integration, uninstall implementation,
full suite, malware verdict, or physical acceptance is claimed. Required new
PKG/DMG flow, automatic verification, branding, workspace chooser and mapping,
client choice, safe maintenance flow, and complete release handoff remain due.
The real arm64 desktop-client bundle/source was found in the sibling
`josi-desktop-macos-0.6.5-e1d28de` worktree, version 0.6.5,
identifier `com.romanvaxman.josi.desktop`, TeamIdentifier `LRH75YR6QW`.
It has not been integrated or launched. Its signature Authority displayed as
unavailable in this session; it still requires full validation before bundling.

## Human blocker

Both `security find-identity -v -p basic` and
`security find-identity -v -p codesigning` returned **0 valid identities**.
The search list contains the existing external build20 Keychain and login
Keychain. No Keychain state, trust settings, or search list was changed.
No signing attempt was made. Roman must make both exact SOCAL Developer ID
Application and Developer ID Installer identities, including matching private
keys, available in his logged-in Keychain session and confirm access approval.
Do not substitute another identity or notarize without separate authorization.

Investigation output (not a release) is retained in the new directory
`installer-investigation-20261010T080000Z/` under the base artifact directory.
Existing accepted ZIP/DMG/app artifacts were only read. No installer was run,
system-wide installation made, push/publication performed, or notarization
submitted. Lifecycle tests use external disposable fixtures only.
