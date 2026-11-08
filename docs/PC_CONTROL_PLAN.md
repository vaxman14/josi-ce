# Josi computer control plan

Updated November 8, 2026. The owner authorized committing and pushing this plan, then starting the Windows implementation and build. Prepare the installer toolchain as part of that work. macOS and Linux implementation proceeds in separate owner-started sessions. Installation, service or administrator changes on the development machine, and release publication still require explicit approval.

Josi will operate the computer where its native app is running: terminals, PowerShell, files, browsers, and desktop applications. The owner chooses how much access to give it and changes those permissions by talking to Josi in chat. Screen control has a visible blue takeover overlay and immediate local controls for taking back the computer.

This replaces the next-step product direction in `WINDOWS_PC_CONTROL_HANDOFF.md`. That handoff remains a historical record of the Windows implementation and tests. Existing functionality is a starting point, not evidence that this plan is implemented.

## Decisions from the owner

- Cover Windows, macOS, and Linux in this order in the plan. Implement them in separate sessions on the appropriate machines. The Mac session can start as soon as this plan is ready; Windows completion or verification is not a prerequisite. Linux likewise has its own implementation track.
- Provide broad computer control, including real terminal sessions and PowerShell, with permissions ranging from a specific operation to full control.
- Make every supported permission change available through chat. A settings page can show the current state, but must not be required to configure it.
- Support permission duration of once, the current task, a chosen time period, or saved until revoked, including administrator permissions.
- Support controlling a paired computer and changing its permissions from phone chat with secure device approval.
- Use a blue takeover experience like the one the owner likes in Codex. Josi implements its own native overlay and execution system; no private Codex component or identical implementation is assumed.
- Discuss implementation and builds with the owner before starting them. Never publish a GitHub release without an explicit instruction. Ask before installation, service, or administrator changes on the development machine.

## The everyday experience

The owner says what to do, and Josi chooses an available direct tool, terminal, browser control, or desktop control. It explains what it is doing in chat and verifies the result. The execution system and permissions remain the same when the owner changes model providers.

Examples of permission conversations:

| The owner says | Josi prepares |
| --- | --- |
| Use PowerShell, but never run as administrator. | A terminal grant with elevation denied, with the actual execution boundary stated. |
| Use any app except my password manager. | Broad app access with a named exclusion and compatible terminal/browser restrictions. |
| Only use Notepad and Calculator. | Access to those identified applications, with unrelated app access denied. |
| Read this project, but do not change anything. | Read access to the resolved project folder; no write-capable execution that defeats it. |
| You can edit this project for the next hour. | A timed grant for the selected project, with a visible expiration time. |
| Allow administrator access for this task. | A task-bound administrator grant and an OS elevation flow when needed. |
| Give yourself full control of this PC until I turn it off. | A clear expansion showing included powers and existing exclusions, followed by secure owner confirmation. |
| What are you allowed to do? | A readable explanation of effective permissions, their duration, and the rules causing any restriction. |
| Stop using Chrome. | Immediate revocation for Chrome, cancellation of affected work, and confirmation in chat. |

For a new grant, Josi shows a compact before-and-after card in chat: computer, capabilities, apps or folders, duration, administrator access, and any meaningful conflicts. The owner can correct it conversationally. A direct, unambiguous instruction is sufficient for ordinary changes; do not demand a redundant confirmation for every sentence. Broad or sensitive expansions use a secure confirmation tied to the exact change. Revocation and Stop are immediate and do not require a password.

Authentication occurs in a native system prompt or protected form, outside model-visible chat. Use available platform authentication, such as Windows Hello, Touch ID, a phone passkey unlocked with Face ID, or a protected password fallback. Availability must be detected. Josi never asks the owner to paste a password into the conversation.

After an approved change, resume the waiting operation without making the user repeat the original request. An expired or changed operation is re-evaluated and explained, not silently substituted.

## Permission model

Use one shared policy format and evaluator across all platforms. Each rule specifies the owner, target device, capability, scope, decision, duration, conditions, and revision. Separate what Josi may observe from what it may change.

| Dimension | Choices to support |
| --- | --- |
| Decision | Deny, ask, or allow |
| Duration | One exact operation, current task, until a selected time, or saved until revoked |
| Applications | All applications, selected application identities, and explicit exclusions; distinguish observe, launch, operate, close, and terminate |
| Terminals | Discovered shells, approved command recipes or general sessions, restricted workspace or broad host access, and permitted subprocesses |
| Files | Selected files, folders, or broad user-accessible storage; read, create, edit, move, and delete separately |
| Browsers | Browser/profile, sites, reading, form input, uploads, downloads, and submissions |
| System changes | User settings, software installation/removal, services, security settings, and administrator execution separately |
| Sensitive actions | Sending information, purchases, and credential use, with enforceable operation-specific limits |
| Remote use | Approved controlling devices, target computers, attended/unattended operation, and permitted background work |

Offer convenient starting choices such as Ask first, Selected apps and folders, Full control without administrator access, and Full control including administrator access. These expand into editable rules. Do not retain the old hard-coded rule that every high-risk capability always asks regardless of the owner's saved permission.

Explicit denials override general allowances. A request to change a denial must identify and replace that denial; granting a broader preset must not erase it silently. App identity uses platform identity information where available, not just a display name. Path resolution must handle links, junctions, aliases, mounts, and case rules on the target platform.

Once grants bind to an immutable operation. Task grants bind to a specific task, device, and owner and end when that task ends. Timed grants expire locally as well as on the server. Saved grants survive restart, but do not automatically resume stopped work. Policies retain their meaning across a model switch.

### Permissions must describe real limits

A command's starting directory does not limit the files it can access. Allowing an unrestricted shell also enables launching programs, networking, and modifying anything the execution account can reach. Similarly, an allowed browser or editor may provide another path to files or code execution.

Therefore provide two execution approaches under the same conversational interface:

- Restricted work uses mediated operations or an OS isolation boundary that actually enforces the promised file, network, process, and elevation restrictions. Compatibility must be proven for the supported tools.
- Broad host work runs with the explicitly granted authority and explains its scope. It cannot simultaneously advertise a narrow restriction that its execution mechanism cannot enforce.

If a requested combination is unsupported, Josi explains the conflict and offers a compatible choice. It never quietly weakens a rule. Semantic limits such as allowing arbitrary browser clicks but forbidding every possible purchase need bounded application operations or an approval handoff; a model instruction alone is not a guaranteed boundary.

Protect permission storage, approval keys, and the execution broker from automation sessions. A model-generated script must not be able to grant itself more access or manufacture approval. Unrestricted administrator authority cannot provide an absolute guarantee against tampering with its own host; make that limitation explicit when granting it. Full control still respects OS authentication and access controls.

## Native execution and visible control

### Terminals and background work

Support PowerShell, PowerShell 7 when installed, and Command Prompt on Windows; discovered supported shells on macOS and Linux. Provide persistent terminal sessions with working directory and environment state, streaming output, exit status, bounded history, timeouts, cancellation, and controlled input. Use a pseudoterminal when interactivity is needed. Show a live terminal view when requested; background commands should not steal keyboard focus.

Track every session and descendant process under its owner, device, task, and effective policy revision. Recheck permission before starting commands or accepting new session input, and cancel or rebuild sessions when their authority changes. A narrower new policy cannot reuse an old process with broader rights. Do not inject terminal commands into whatever window happens to be focused.

### Applications and browsers

Prefer structured application APIs, browser interfaces, and accessibility controls. Use screenshots and targeted pointer/keyboard input when needed. Support observation, clicking, typing, scrolling, dragging, window management, application discovery, and opening files with approved applications.

An observation records its target app, process/window identity, geometry, display scale, and timestamp. Validate the target again before acting and refresh after relevant changes. Do not reuse stale coordinates after a window move, focus change, or display change. An app-scoped observation must not capture neighboring forbidden windows.

### Blue takeover overlay

Build a native translucent blue treatment around the active screen or controlled window, with a persistent control strip showing the task and current action. Keep the work visible. The overlay remains available when the main Josi window is behind another application and supports multiple displays.

Controls: Take over, Pause, Resume, Stop, and Permissions. Permissions opens the relevant conversation and current grant summary. Offer a configurable local emergency shortcut and an accessible control outside model-driven input.

Real user mouse or keyboard input takes back screen control immediately. Resume requires an explicit user action or chat instruction; remove the current automatic 20-second return to control. Background commands can continue under their existing grant while the user uses the desktop, and their status remains visible. Pause stops new automation and screen input; running jobs are explicitly shown and can be stopped. Stop cancels all task-owned execution and invalidates queued work. Completed side effects are not automatically undone.

The overlay is a status and control surface, not an authentication screen. Hide or yield it during OS authentication, and exclude Josi's overlay from screenshots where supported. Never imitate an OS password prompt. Local stopping must work without the model, server, or internet.

## Chat authority and remote control

Chat is the permission interface, but the model is not the authority that approves its own actions. Expose typed tools to inspect effective permissions, propose a change, explain a denial, and track an approval. These tools remain available even while execution is disabled, so the owner can enable or repair access conversationally.

The trusted application binds a permission proposal to the authenticated owner's direct chat instruction. Documents, websites, terminal output, screenshots, and quoted messages cannot authorize a grant. Bind secure approval to the owner, target device, exact proposal digest, policy revision, expiration, and a single-use challenge. The native approval surface renders trusted structured data and cannot be operated by Josi's own automation path.

Pair each target computer and controlling phone with device identity and revocation support. A server hosting Josi is not automatically the computer being controlled. Name the target in chat, approval cards, the takeover strip, and activity entries. The target executor verifies device-bound authorization; a caller-supplied computer ID alone is insufficient.

Allow approved phone chat to initiate work, change permissions, review activity, and stop work. Strong confirmation on the paired phone can authorize a Josi permission change, but does not replace an OS prompt required on the target computer. Local input always wins. Use a short renewable execution lease so disconnected clients cannot leave screen control running indefinitely; choose and test the exact lease during implementation.

Attended control is the initial default. Unattended work is a separate chat-configurable grant. The plan does not promise screen control through a locked desktop, login screen, or protected OS prompt. Supported background tasks may continue while locked only under an explicit grant and a tested platform execution model.

## Shared implementation contract

Before platform implementations diverge, define a versioned contract and common fixtures for:

1. Device identity, capability discovery, target selection, and connection state.
2. Policy rules, effective-policy explanations, revisions, and atomic updates.
3. Permission proposals, authenticated approvals, cancellations, and expiration.
4. Execution requests with declared capabilities, task/session identity, policy revision, lease, and idempotency key.
5. Observation references, terminal input/output, results, and activity events.
6. Cancellation, local stop state, reconnection, and explicit resume.

Use an atomic grant-and-resume operation to replace the current save-policy-then-approve sequence. Re-evaluate the exact waiting request against the new policy; claim and execute it at most once. All execution paths use the same effective policy. Local verification remains mandatory when the server has already approved a request.

Maintain a cancellation path independent of a long-running executor claim or command. If the native broker or control overlay fails, stop active screen input and fail closed. Store a concise activity history with the decision, scope, originating device, outcome, and timestamps. Keep passwords, tokens, and raw sensitive command output out of ordinary logs; allow the owner to manage history retention through chat.

Model capability detection must be honest: a model without image input cannot operate a screenshot-only interface. Report supported text/accessibility alternatives or ask to use a suitable configured model. Keep execution adapters independent of any one model provider.

## Windows implementation track

Begin with the existing C# WPF app and TypeScript server. Reuse useful command/file operations, accessibility code, observation checks, and tests after review. Replace the limited permission workflow and app-only activity banner.

| Stage | Deliverable | Evidence required for this platform |
| --- | --- | --- |
| W1 | Shared contracts, chat permission proposals, device binding, atomic approval/resume | Contract tests, exact consent binding, concurrent policy-change and replay tests |
| W2 | Restricted and broad terminal execution, persistent sessions, streaming and cancellation | Real PowerShell/cmd sessions; boundary tests; descendants stopped; no wrong-window input |
| W3 | Reliable desktop observation/actions and native blue overlay | Real multi-monitor and mixed-DPI interaction; takeover; stop during server loss |
| W4 | Protected confirmation, optional administrator broker, paired-phone flow | Saved/task/timed/once grants; denied elevation; phone revocation and target verification |
| W5 | Installer integration and real-chat acceptance | Signed artifact review, owner-approved installation, retained data and tested upgrade |

Use UI Automation and an appropriate native capture API for targeted windows. Evaluate Windows Graphics Capture for capture quality and occlusion behavior. Evaluate ConPTY for interactive terminals and Job Objects for owned process lifetime. Prove restrictive execution with an appropriate Windows isolation mechanism before promising folder/app/network confinement; do not treat string checks or PowerShell execution policy as a sandbox.

Keep normal execution unelevated. A separately authorized privileged helper handles approved administrator operations. Windows Hello verifies the owner's intent; UAC provides OS elevation when required. A saved Josi administrator grant does not mean Josi clicks or bypasses UAC prompts.

Likely code touchpoints: `packages/core/src/pcControl.ts`, `packages/agent/src/pcDesktopTools.ts`, `packages/agent/src/assistantAgent.ts`, `apps/api/src/http/pcControlRoutes.ts`, and `apps/windows-native/src/{PcWork,DesktopExecutor,BrowserBridge,PcControl,MainWindow}.cs`. Native and web chat need permission cards; configuration must no longer require navigating to PC Control settings.

## macOS implementation track

Start a separate session on the Mac as soon as this plan is available. Do not wait for Windows implementation or verification. Read the native Mac code and its existing protected-approval and device-enrollment mechanisms before replacing anything. Reuse the shared contract and fixtures; coordinate contract changes across sessions.

Implement the same chat permissions, terminal sessions, phone approvals, blue takeover controls, and revocation behavior in SwiftUI/AppKit. Candidate platform integrations are Accessibility for structured controls, ScreenCaptureKit for capture, native pseudoterminals for shells, and LocalAuthentication/protected credentials for owner confirmation. Confirm current APIs and hardware support on the Mac during kickoff. Authentication and administrator authorization remain separate.

Inventory and request the OS permissions actually required. Preserve existing denial and enrollment behavior. Do not default this project back to the older VM-only desktop plan: the owner's request is to control the Mac they use. Isolation may still be used where necessary to enforce a restricted terminal grant, with clear file/application access semantics.

Stages: Mac baseline and contract integration; chat permissions and protected consent; shell and desktop adapters; overlay and remote control; packaging and real-chat acceptance. Validate on the target hardware, including permission denial, revoked accessibility/screen access, application identity changes, locked screen, and process cleanup. Signing, notarization, installation, and publication have their own owner approval boundaries.

## Linux implementation track

Start a separate Linux session against the same contract when the owner chooses. It does not depend on a Windows or Mac release. Inventory the existing desktop client and select the native integration strategy on that machine.

Provide shell sessions, mediated file operations, application discovery, and structured desktop access where available. Plan Wayland support through XDG Desktop Portal RemoteDesktop/ScreenCast with PipeWire and supported input mechanisms; evaluate AT-SPI for accessibility. Portal support varies by compositor and version. Maintain a separate, tested X11 path rather than assuming one input method works everywhere.

Use a Linux-native protected authorization flow, normally through polkit for privileged operations. Determine and test the isolation backend for restricted commands, including filesystem, network, subprocess, and privilege boundaries. Do not use unrestricted sudo as the implementation of a narrow grant.

Stages: distribution/compositor baseline and contract integration; chat permissions; terminal/file/desktop adapters; overlay and remote control; packaging and real-chat acceptance. Choose and publish an explicit initial support matrix, with GNOME Wayland and KDE Wayland as proposed targets and X11 tested separately. If a desktop cannot provide a reliable takeover/Stop surface or required capture/input authority, report that capability unavailable rather than silently weakening control.

## Acceptance scenarios for every platform

1. From chat, grant terminal use without administrator access. Run an ordinary command, then verify a requested privileged action is blocked without disabling terminal use.
2. Grant only two apps. Verify direct launch, UI interaction, and indirect terminal/browser paths cannot reach a forbidden app under the advertised enforcement mode.
3. Grant one folder. Verify outside paths, links, subprocesses, and existing terminal sessions cannot defeat the restriction. Show a clear conflict if broad execution is incompatible.
4. Grant full control through chat, authenticate once for that grant, and complete a multi-step terminal/app/file task without repeated Josi prompts inside its scope.
5. Exercise once, task, timed, and saved grants, including expiry, restart, model change, and revocation during running work.
6. Change a permission during an approval wait. Resume the exact request once without the existing revocation/409 behavior or duplicate execution.
7. Watch desktop control through the blue overlay, take back the mouse/keyboard, and verify that Josi waits for explicit resume. Test multiple monitors and display changes.
8. Stop while the server is unreachable and while a command has child processes. Verify local input stops, owned work is canceled, and reconnection does not restart it.
9. Start work from a paired phone, approve a scoped change, revoke it, and verify the correct computer and authenticated owner throughout. Test lost connectivity and device revocation.
10. Present permission-changing instructions inside a webpage, document, screenshot, and terminal output. Verify they cannot change policy or approve a request.
11. Verify protected prompts, password entry, and credential material stay outside model context and ordinary activity logs. Test denied or unavailable native authentication.
12. Upgrade an existing installation without changing its permissions or data silently. A migrated working-directory grant must not be mislabeled as a file-access boundary; explain any migration needing owner choice.

Record actual results and exact errors on each platform. Existing unit tests do not substitute for a real model/chat/executor run. Each platform must pass its release checks before that platform ships; those checks do not block work in the other platform sessions.

## Session handoff and first implementation step

Windows, Mac, and Linux sessions should start by reading this plan, their local repository instructions, and the current shared contract. Use separate branches/worktrees and coordinate shared schema changes through explicit versioning and compatibility fixtures. Record the contract version each platform supports. Do not let one platform silently redefine permission semantics for the others.

The first authorized implementation phase, after discussion with the owner, should produce the shared permission/approval contract and one real chat flow: request a scoped permission, securely confirm it, execute a small operation, change or revoke the permission from chat, and verify the changed behavior. Build the remaining capabilities on that complete path.

For Windows commits use `git -c user.name="Roman Vaxman" -c user.email="roman@Romans-MacBook-Pro.local" commit ...`; never change global Git configuration. Do not type or store the owner's secrets. Windows UI test drivers must avoid SendKeys and use the existing non-conflicting port 8801 where applicable. No releases are published as part of this planning work.

## Technical basis

The proposed architecture combines structured tools, terminals, and native computer interaction. OpenAI's public computer-use interface leaves the driver, session, permissions, and cleanup with the application; it does not establish that Codex's native overlay is a reusable component. See [OpenAI computer use](https://developers.openai.com/api/docs/guides/tools-computer-use).

Windows offers OS-enforced isolation mechanisms, but compatibility and exact restrictions need proof for Josi's workloads. See [Microsoft application isolation](https://learn.microsoft.com/en-us/windows/security/book/application-security-application-isolation). Owner verification and OS elevation are different operations; see [UserConsentVerifier](https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier) and [how UAC works](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/user-account-control/how-it-works).

The Linux portal supports consented remote input and integration with screen capture; compositor capability and persistence must be detected. See [XDG RemoteDesktop](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html). Mac API choices above are implementation candidates to verify in the Mac session, beginning with [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit).
