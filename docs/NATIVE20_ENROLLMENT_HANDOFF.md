# Josi native.20: resume enrollment after Touch ID

This update retains native.19's branding, verified device inventory and one-second worker queue polling. It changes the native client, not the enrollment protocol, credential checks or Vault records.

## Observed failure

The October 20 attempts at 3:34–3:35 PM returned HTTP 401 during enrollment preparation. Roman subsequently confirmed that an incorrect password had been entered in the enrollment form. With the corrected Josi password, preparation returned HTTP 200, the protected review appeared and the second Touch ID evaluation succeeded at 3:46 PM and 3:48 PM. The client then cancelled the attempt before sending its commit. No completed enrollment was established by those attempts.

The native client immediately required its review window to be visible and Josi to be active after the separate key helper returned from Touch ID. macOS's focus-restoration events overlap that return. This exposes a race in which successful authentication is followed by cancellation while the review is returning to the foreground. The logs locate the failure at this handoff; live confirmation on native.20 remains necessary to establish that it resolves Roman's attempt.

## Change

After successful authentication, the client waits for Josi to be active and the review visible. It uses the original wall-clock and monotonic approval deadline, checks cancellation on every wait, and stops if the review closes. It never activates a background app automatically or retries authentication. The existing exact-request, session, device, signature and server-consent checks still run before commit. The same handoff is used for separate-desktop storage and automation approval.

Enrollment errors now identify the stage and preserve the bounded HTTP error text. An account-verification failure no longer tells the user that server-Mac approval is missing. A lost commit response continues to instruct the user to refresh saved devices because the enrollment may already exist. The password field explicitly says “Josi administrator password.” The system log records only the failing stage and HTTP status, with no identities, credentials, material or response text.

## Verification

The native harness compiles the actual application sources and checks delayed return, expiry, cancellation and closed-review failure. It also checks enrollment error mapping and uncertain commits, then runs the existing native HTTP inventory checks. These are controlled readiness fixtures; they do not replace a physical Touch ID acceptance attempt.

The authentication/enrollment regression suite passes 13 tests. The queue regression suite passes 2 tests. The installer build additionally compiles the optimized Swift client and verifies application and installer signatures, then compares the extracted installer payload with the signed staging files.

## Acceptance

Install native.20, open Automation → Devices and refresh saved devices. If MBP is already listed, use that enrollment. Otherwise start one enrollment with the correct Josi password, approve the exact review and complete Touch ID. Keep Josi in front afterward. Success requires the saved-and-verified confirmation and MBP appearing in both Devices and Enrolled Mac. Enrollment alone does not connect the separate desktop; that setup follows once the device is listed.

This is a signed local build, not a notarized public release. No enrollment or automation approval has been performed on the user's behalf.
