# P6/P8 native component implementation

19 October 2026. Source and compilation checkpoint; no production authority connection or live execution.

## Isolated desktop lifecycle

`apps/automation-macos/Sources/WorkspaceMachine.swift` implements Apple Virtualization lifecycle for an already provisioned workspace on a Vault-backed encrypted mount: open/start, pause, resume, separate viewer, stop, and ordered channel/machine/storage closure. The mount provider supplies the verified volume identity and platform data. Disk and auxiliary-storage files must be private regular files on that volume. Startup validates the actual Virtualization configuration.

There are no shared host folders, NAT interface, audio capture devices, suspension snapshots or personal-desktop fallback. The real virtio socket device is available to the authenticated channel assembler. Selective network access still needs its transport; this source currently builds an offline workspace.

Host-viewer mouse/keyboard input invalidates the automation lease before forwarding input into the guest. Closing the viewer hides it and leaves the task intact. Pausing revokes input. Resuming the machine does not restore an old execution lease. Channel loss/Vault revocation has a closure path that hides the viewer before cleanup. Stop detaches the viewer and VM before attempting storage closure. Busy unmount or failed teardown remains a repair state with its mounted-volume handle retained.

Provisioning, encrypted mount implementation, signed host application, persistent workspace catalog, local/remote enrollment, authenticated guest channel, selective networking, file exchange, and integration into the unified app remain to connect. Required commercial macOS VM permission remains with the owner.

## Guest computer-use engine

`GuestDesktopEngine.swift` implements native macOS Accessibility observation, element press/focus, bounded mouse clicks, text projection, a small explicit key set and ScreenCaptureKit capture of one current approved window. Every operation requires an isolated-guest authority adapter; there is no executable entry point, listener or default permissive adapter.

The observation records the real foreground process, launch time, bundle/executable identity, focused window, bounds, bounded accessibility nodes and an opaque snapshot ID. Generic input values and secure text fields are omitted. Tree traversal is bounded; partial observations are labeled. Screen capture requires existing OS screen consent and separate authorization, excludes child windows/audio/cursor, and returns bounded PNG bytes only in memory.

Input requires the same workspace/session/generation and a recent observation. The engine checks window identity, foreground app, geometry, focus and the accessibility fingerprint again after asynchronous authorization. It consumes the observation before issuing input. Native calls return “input issued,” not task success. An error after dispatch is uncertain and revokes control. Text is projected from a reference, bounded to 256 UTF-16 units per action, and is neither logged nor returned. Secure event input, system credential/settings apps, Josi's own controls, and unsupported operations are refused.

Real guest input is monitored as a secondary stop signal. Event metadata is not a security identity; the host viewer's synchronous takeover and verified channel/lease remain mandatory. No claim is made that accessibility fingerprints detect every possible hidden application change, or that OS capture can classify arbitrary sensitive pixels. Execution/effect classification and protected-content policy must be implemented by the verified adapters.

## Build and outstanding acceptance

`scripts/macos/build-automation-components.py` builds separate host and guest Swift 6 libraries for Apple Silicon/macOS 14.2+, with hashes and explicit unsigned/uninstalled/unexecuted metadata. This is a compilation target for the source components, not a runnable app or signed distribution. The libraries compiled; no Accessibility consent was requested, screenshot taken, guest input sent, VM launched or functional test run for this checkpoint.

Still open: signed host/guest packaging and runtime assembly; authenticated current authority; OS consent UX; exact input behavior; browser/native action routing; outcome verification; protected-content filtering; remote live view; networking; provisioning/recovery; resource validation and integrated acceptance. The P0 fixture channel remains a fixture and is not relabeled as production authority.
