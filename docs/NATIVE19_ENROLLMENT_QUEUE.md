# Josi native.19: verified enrollment inventory and faster queue pickup

This update batches the two fixes Roman authorized on October 20. It retains the native.18 branding and chat controls.

## Enrollment and saved Macs

The reported failure was a successful enrollment message followed by empty Devices and Enrolled Mac lists, even after a full refresh. The old client acknowledged the commit before confirming the enrolled Mac in its displayed inventory, and all device views depended on the combined rules, permissions, drafts and targets response.

The server now re-reads the canonical inventory after the enrollment transaction commits. It confirms the exact enrollment and device before returning success, together with that inventory. The native client validates the result and installs it into shared device state before displaying success. Device reads have a separate authenticated administrator endpoint, independent of other Automation settings. Protected approval and storage preparation use that same state and remain disabled when it cannot be verified.

Refresh Saved Devices, Refresh Pending Enrollment Requests, Refresh Enrolled Macs and Refresh Desktops now identify the inventory each refreshes. Missing or malformed inventory produces a visible error instead of an empty-device assertion. Generation and record-version checks prevent older responses from replacing newly confirmed state. Sign-out, disconnect and access loss clear it. Device records from another configured server address remain visible in Devices but are not offered as approval or storage keys for the current address.

No Vault schema, enrollment persistence format, authentication requirement, existing enrollment or automation grant was changed. Existing data is read through the canonical Vault store. Live protected database access was unavailable, so the original MBP record and the exact cause of its disappearance have not been verified. The defensive corrections are tested; recovery of that specific enrollment is an installation acceptance check.

## One-second queue check

The worker checks the queue every second instead of every 30 seconds. In-flight passes never overlap. Schedule promotion, expired authentication cleanup, periodic push maintenance and storage health probes keep their previous cadence. A busy pass still finishes before another starts. Model generation time and the native client's existing display-refresh timing are unchanged.

## Verification and acceptance

TypeScript compilation and Swift 6 typechecking pass. Twenty-nine regression tests cover the queue, enrollment commit/read-back, independent inventory reads, access denial, locked Vault behavior and retained enrollments. Physical Touch ID consent is simulated only in the HTTP test fixture; password verification, signatures and Vault transactions execute normally.

A disposable instance of the bundled PostgreSQL engine applied the real migrations and verified committed enrollments from a separate physical database connection. The native harness uses the actual HTTP decoder and model against disposable loopback responses to verify malformed-response handling, stale replies, owner isolation, independent device state and access loss. It renders the workspace storage view using sample data. The final installer is signature-checked, extracted and compared with its signed staging payload.

The installer is a signed local candidate, not a notarized public release. It has not been installed over the running native.18 application. After installation, open Automation and use Refresh Enrolled Macs or Devices → Refresh Saved Devices. Confirm MBP before starting another enrollment. If the canonical inventory still has no MBP, the original record needs live inspection; do not infer that a duplicate enrollment will repair it. Website filling still requires a connected separate desktop and its existing permission setup.
