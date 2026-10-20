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

## Managed encrypted image operations — 20 October

`packaging/macos/automation-workspace.py` supplies actual create/attach/status/detach operations for the forthcoming native coordinator. It accepts one bounded stdin request, derives a per-user managed path from the OS account and exact workspace UUID, serializes operations with a private lock, and invokes fixed disk-image commands without a shell. Image passwords arrive only through stdin and are neither resolved nor persisted by this helper. The caller must obtain them from the current canonical Vault projection.

The helper validates managed ancestry and image files, rejects links and shared writable storage, records only nonsecret local storage state, keeps uncertain/partial operations for repair, and verifies the exact image-to-mount association before and after normal detachment. It never forces detach, deletes images, accepts arbitrary paths or operates another volume. Crash-left transitional states report repair; a busy/unconfirmed detach cannot become a reported closed workspace. VM and channel consumers still must close before the caller requests detachment.

This uses the existing `hdiutil` route for macOS 14.2+ compatibility. The installed newer macOS command advertises deprecation in favor of `diskutil image`; help was inspected without changing disks. The newer API does not provide the same detach/inventory command shape, so there is no guessed substitution. Real supported-version acceptance remains open. The 64 GiB free-space admission plus 8 GiB reserve and 64–512 GiB logical capacity range are conservative implementation bounds, not measured customer minimums.

The original helper checkpoint did not connect these operations to the app. The following checkpoint connects storage creation; attachment and VM assembly remain separate.

## Native Vault-backed storage preparation — 20 October

The native Automation page now assembles storage preparation from the signed app, enrolled hardware key, CE session, encrypted Vault registry and managed image helper. The administrator chooses an enrolled Mac, workspace name and 64–512 GiB logical capacity; a native review shows the exact server, owner, device, workspace and storage meaning before Touch ID. The helper accepts a separate fixed `josi-workspace-storage.1` message; its signature cannot approve a Cardinal Rule or input action.

CE challenges expire after 60 seconds, are bounded, one-use and tied to the initiating session. Provisioning checks the live administrator/session, installation, enrolled nonrevoked hardware key, exact current Vault reference/epoch, owner box lock, reconciliation and signed request inside the Vault transaction. Disk passwords/configuration use the new encrypted `workspace_storage` record kind and existing versioned history. Generic record reads/writes cannot export or replace the registry. No password enters a command argument, preferences, local journal, chat or diagnostic log; only the explicit authenticated native projection receives it transiently.

An exact retry retains the original workspace ID and Vault password. A response lost after Vault commit can be resumed from the registry without replacing the credential. The native flow checks existing local state, refuses unfinished or mounted storage, creates only a missing image, and leaves it closed. Local status handles an absent managed directory without creating one. The app verifies its installed Socal signature before running its bundled Python helper. Creation receives the short-lived projection before admission; the approved bounded disk operation may finish after that lease, but never mounts or starts a desktop.

This is assembled source and builder integration, **not a newly delivered installer or demonstrated disk operation**. The `native.4` installer predates it. TypeScript, native Swift and protected-helper compilation are the checkpoint checks; no live Vault enrollment/projection, disk creation, attachment, biometric flow or VM operation was exercised. Full functional tests remain deferred under the owner's build-first instruction.

The first assembled provisioning path is administrator-owned because it uses the existing protected-device registry. Ordinary-user automation-device pairing remains open; remote chat clients keep their existing behavior. Storage registration is not an automation grant. Guest installation, app-level mount/lease/lock closure, runtime authority, recovery/migration of an enrolled device, guest transport, networking and computer/browser control remain required before P6/P8 acceptance.

## Native development desktop assembly — 20 October

The next source checkpoint connects `WorkspaceMachine` directly to the SwiftUI app. The native storage page can select an Apple `.ipsw`, install it into the encrypted workspace, open the resulting separate desktop window, show it again, pause/resume and close it. CPU/memory are bounded by this Mac's resources and the restore image requirements. Guest machine identity, auxiliary storage, disk and installation journal are private files inside the encrypted volume; they are operational metadata, not authority or a second credential store. Existing and interrupted guest files are never automatically overwritten.

Opening requires its own exact native review and enrolled hardware proof. CE projects the existing canonical Vault password and starts a session bound to the owner, cookie session, server, enrolled device, workspace and current Vault reference. The native app renews a ten-second lease every two seconds, with an independent local watchdog; the reviewed development session has a two-hour ceiling. Each renewal checks current Vault/box locks, reconciliation, enrollment/revocation and live administrator session. A Vault epoch change, expired lease, server restart, account change or connection failure ends this session. Polling detects changes within the lease; this is not an instantaneous remote-revocation claim.

After loss, sign-out, server lifecycle operations or normal app quit, the native owner hides/stops the VM, releases viewer/disk handles and requests normal detach. A failed stop or detach retains handles and a visible **Close Again / needs repair** state; there is no forced unmount or reported success. Sleep ends the session instead of silently resuming it. Cleanup runs outside the heartbeat task so cancelling monitoring cannot cancel the required unmount. An interrupted installer also retains a still-running VM handle until shutdown is confirmed. Installation monitors both the image's free blocks and the physical backing filesystem, preserving an 8 GiB reserve; initial installation requires 64 GiB physically free after the restore image is present.

The builder includes the VM source and signs the main app with the macOS virtualization entitlement under the existing Socal identity. The version is advanced to `native.5`; packaging evidence is recorded separately after the installer is actually produced.

This remains an administrator-owned **development desktop** while the owner pursues commercial VM permission. It has no NIC, host directory share, clipboard bridge, audio device, guest automation executable or guest command channel. Owner input in the VM viewer is available, but agent computer/browser tools are still unavailable. No permissive authority adapter or fixture channel is substituted.

TypeScript and Swift/helper compilation are the checks for this assembly. No live workspace was mounted, restore image loaded, VM installed/launched, Touch ID flow exercised or functional acceptance run. Forced app death/OS crash cleanup, startup reconciliation, tested busy-handle recovery, disk/resource exhaustion, ordinary-user pairing, guest transport, guest consent, selective networking and actual automation remain release gates. In particular, the current in-app owner cannot promise to detach a volume after that process is forcibly killed; an independent ownership/recovery path must be completed before production acceptance.

## Parent-loss cleanup and retained storage — subsequent source checkpoint

A separate private Python child now monitors the native owner's pipe, parent PID and ten-second liveness signals before storage attachment. One private per-workspace lock prevents two guardians from claiming the same image. The child receives no password, Vault material, shell command, arbitrary path, input or networking capability. The native owner renews it only after successful CE lease renewal. Loss of the parent/pipe/liveness triggers bounded attempts to normally detach the exact managed image; a false `closed` message is checked against actual mounts. Clock rollback ends liveness.

Normal close first confirms detach, then tells the guardian to exit. A dead guardian ends the native desktop lease. The Automation page also has an explicit **Inspect / Close Storage** control for retained storage after relaunch. It preserves files and refuses to force busy volumes. Installation-journal repair is separate from successfully closing storage.

This provides an independent best-effort cleanup path, not a promise that every OS/forced-kill scenario can unmount: a still-live hung VM or a busy filesystem can require repair. Each detach attempt and total retry count are bounded. OS reboot reconciliation, actual forced-exit/sleep/busy-handle behavior and integrated functional acceptance remain open. This checkpoint changes source/builder version to `native.6`; no `native.6` installer has yet been produced. The delivered `native.5` artifact does not contain this guardian.
