# Josi native.18: branded native chat and automation recovery

This update implements the approved navy, cream and orange design in the native SwiftUI/AppKit client. It retains the native navigation layout and original J logo, with a redesigned chat transcript, rounded message composer, voice-model controls, dictation, voice conversation and animated thinking J. Enter sends; Shift+Enter inserts a new line. Input-method composition does not accidentally send a message.

## Automation connection fix

Automation presence discovery queried `workspace.installation_id`, which does not exist in the database schema. Enrollment, storage and protected-change routes also read the installation identity from the wrong table. They now use the canonical `install_identity.install_id` record. This preserves the existing identity, device enrollment, Vault rules and permissions.

Automation and Vault settings now load independently. The screen distinguishes loading, a status-read failure, a locked Vault, an unavailable runtime, a missing workspace, an offline device and missing local consent. Connection errors no longer appear as a successful check reporting no connection.

If a model ends a work segment without saving its progress, Josi requests a checkpoint once within the existing turn limit. If recovery is still needed, Task Manager retains the original goal and steps, reports a verified automation blocker when available, and allows Continue without requiring the user to rewrite the task. Existing failures and their history remain visible. Continuing rechecks connection and saved results; it does not grant permissions or blindly repeat page edits.

## Updating and continuing

Quit Josi, install `Install Josi.pkg` over the existing application, and reopen it. This package updates both the native app and its bundled server. It retains the existing ChatGPT-subscription model integration; no OpenAI API key is needed for that integration.

Open Automation and Refresh. If the separate desktop still needs setup, follow the specific status shown there. Open the desktop, connect Josi Companion, select Chrome and enable automation through its local controls. Existing site and model-transmission permissions still apply. Then return to the saved task and Continue. There is no need to restate the description-writing request.

Voice controls use Josi's existing Voice Box service and its local Whisper/Kokoro models. The voice chip opens setup or model selection. macOS requests microphone access only when dictation or voice conversation starts. The ChatGPT subscription remains the chat model; Voice Box supplies speech recognition and playback.

## Verification

- TypeScript build and full Swift 6 typechecking passed.
- 37 focused automated tests passed across nine test files, including real-schema installation identity, automation discovery, saved-goal recovery, subscription image delivery, structured tool handling and Voice Box API behavior.
- A native offscreen harness rendered the actual chat and Task Manager views with fixture data. Those images were visually reviewed.
- Actual `NSTextView` key events verified Enter sends, Shift+Enter inserts a newline, Command+Enter sends and input-method composition does not send.
- The installer builder verifies Socal signatures, extracted application signatures and package payload integrity before completing.

Live signed-in photo inference and website filling remain acceptance checks after installing this update. Live microphone capture and spoken replies have not been exercised. Preview images use sample messages and task data. This is a signed local test candidate, not a notarized release.
