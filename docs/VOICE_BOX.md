# Optional Voice Box

Voice Box adds browser microphone chat to Josi CE. It is off by default, makes
no database migration, and changes neither the default Compose stack nor its
readiness checks. Existing installations continue working without it.

The default voice is **Kokoro v1.0 / Heart**, with Bella also available. English
pronunciation uses Misaki and a pinned local spaCy tagger. Piper is an explicit
lightweight neural fallback, never an automatic quality downgrade. The CPU path
uses int8 Whisper Base English and quantized Kokoro; Tiny English is available
for lower-resource hosts. Only the selected TTS
engine is loaded. Audio is transient memory; normal chat transcripts retain the
same Josi permissions, retention and model-provider behavior as typed chat.

## Status of this branch

No Voice Box image has been authorized for publication. The production image
catalog is empty on purpose; Admin shows the installation requirements and a
disabled Install button until the host helper has an approved image. An admin
cannot supply a different registry, tag, digest, command or filesystem mount.
Changing application code does not publish an image or upgrade an installation.

See [the redistribution review](../services/voice-box/LICENSES.md) for separate
engine, model and voice terms and remaining artifact-level release obligations.
The owner must authorize any public image, release workflow or gate upgrade.

## Host requirements and one-time opt-in

- 64-bit Linux, Docker Engine and Compose v2 or newer; systemd for the supplied
  helper provisioning script. The initial CPU target is Linux amd64.
- At least 4 GB available memory and 5 GB free disk, in addition to Josi's needs.
  Real-time throughput depends on CPU load and speech length.
- HTTPS or localhost for microphone permissions. Plain LAN HTTP cannot acquire
  the browser microphone. The user must explicitly start voice chat and grant
  browser permission; embedding Josi on another origin does not grant access.

From a reviewed checkout, the host operator runs:

```sh
sudo bash scripts/enable-voice-box-helper.sh
```

This installs a dedicated host service with Docker-group authority. That
authority is confined to reviewed helper code, never given to the Josi app or
voice container. Provisioning requires host administrator access because a web
application cannot safely grant itself Docker authority. The app container's
group is 1000 in the standard image; set `JOSI_VOICE_APP_GID` only if using a
different numeric group. The helper's code/catalog are root-owned; private
state is mode 0700; the 0600 installation token never reaches the browser.

Use the optional overlay when starting the **same pinned Josi application
version** that includes Voice Box support:

```sh
export JOSI_VOICE_SOCKET_DIR=/run/josi-voice-box
docker compose -f docker-compose.yml -f docker-compose.voice-box.yml up -d --no-deps web
```

Then open **Admin → Voice Box** and choose **Install Voice Box**. The helper
pulls only the operator's approved version-and-digest-pinned image, starts its
dedicated project, and verifies model readiness. It accepts only install,
update, restart, uninstall, rollback and validated settings operations. The
helper has no API for running commands, building images, selecting volumes or
managing other services. It clears Docker/Compose environment overrides.

The app sees only `/run/josi-voice-box/helper.sock`. A second Unix socket in the
helper's private state connects the helper to the gateway. The voice container
has **networking disabled**, no published ports, no Docker socket, no Josi data
volumes, a read-only root filesystem, dropped capabilities, a non-root UID,
bounded processes and a 4 GB memory ceiling. Models are already present in the
verified image; speech use cannot make a model download or internet request.

The approved image catalog records available engines per immutable image, for
example `"engines": ["kokoro", "piper"]`. The admin page disables engines absent
from the active image. The standard candidate includes both runtimes, but only
the selected one is imported and loaded. Piper's internal phonemizer does not
participate in the Kokoro path and is never exposed as a standalone voice.

## Readiness and controls

The private `/health` endpoint reports API readiness and whether models have
loaded; `/ready` returns 503 until STT, Silero VAD and the selected TTS engine
complete warm-up inference. The helper does not unlock settings merely because
a TCP listener or HTTP handler exists. Failed initialization remains visibly
unready, and existing typed chat remains usable.

After initial successful verification, Admin shows engine, voice, model, speech
detection threshold, pause duration, speaking speed, preview, update, restart,
rollback and uninstall. Saving restarts only Voice Box and rechecks the selected
models. A failed change restores the previous healthy image and settings when
possible; recovery failures are reported. Operational recovery controls remain
available if a once-verified installation later becomes unhealthy. **Preview
voice** plays a fixed local sample of the saved, verified selection.

## Browser conversation

Choose **Start voice chat** on Talk. Browser audio is continuously resampled to
mono PCM16 at 16 kHz and sent in ordered 500 ms frames through Josi's authenticated,
CSRF-protected API. Silero identifies speech, Whisper returns partial hypotheses,
and a pause commits the final transcript through the existing assistant endpoint.
No separate model/tool policy is created for voice. Sessions are owner-bound;
even a super-admin cannot submit audio to another member's voice session.

Replies are split into bounded speech segments and played in order. Speaking
again or choosing **Interrupt speech** stops playback and suppresses stale
speech that is still being generated. Interrupting does not undo assistant
actions already accepted by the normal conversation endpoint. New utterances
queue behind an in-progress assistant turn so tools are never duplicated by
cancelling and retrying a chat request. **Stop voice chat**, leaving Talk, or
signing out stops microphone tracks and closes the audio session.

At most four sessions and one per user are allowed. Frames, replies, connection
counts, queue length and audio duration are bounded. Idle sessions expire after
60 seconds. A host that cannot process frames fast enough stops voice capture
with an explanatory error rather than accumulating an unlimited backlog.

## Update, rollback and uninstall

### Optional NVIDIA acceleration

The default image contains no CUDA libraries. An operator can build the separate
`gpu` target with `docker build --target gpu` after reviewing NVIDIA's runtime
terms. This target pins cuBLAS 12.8.4.1 and cuDNN 9.8.0.87 with artifact hashes.
The image remains CPU-default until the admin explicitly chooses CUDA. Its
approved catalog entry must have `gpu: true`; a CPU-only digest cannot request
devices. NVIDIA Container Toolkit must already be configured on the host.
The helper requests exactly one compute-capable GPU, with no arbitrary device
mount API. A failed GPU model check rolls back to the last healthy CPU settings.
Kokoro/Piper TTS stay on CPU in this version; GPU acceleration applies to STT.

GPU image publication requires its own redistribution review, including the
[CUDA runtime terms](https://docs.nvidia.com/cuda/eula/index.html) and
[cuDNN terms](https://docs.nvidia.com/deeplearning/cudnn/backend/latest/reference/eula.html).
These proprietary libraries are not described as open-source software or folded
into the CPU image's license claims.

Update selects the newest approved catalog entry; it never resolves `latest`.
The last healthy image/settings remain available for rollback. Failed installs
remove their own partial service. Failed updates attempt to reactivate the last
healthy configuration and display the failure. Helper restarts retain state and
report interrupted operations rather than declaring them successful.

Uninstall removes only the dedicated Compose project's service/network. It does
not delete conversations, Josi volumes, unrelated Docker resources, image cache
or the helper's configuration/token. Retaining configuration permits recovery.
To remove the host integration too, the operator disables the helper service
and restarts the pinned Josi web service without the overlay. Preserve a copy
of `/var/lib/josi-voice-box` before deleting that private state manually.

## Development and verification

```sh
docker build -t josi-voice-box:0.1.0-dev services/voice-box
python3 scripts/test-voice-box.py "$(docker image inspect josi-voice-box:0.1.0-dev --format '{{.Id}}')"
python3 -m unittest discover -s services/voice-box -p 'test_*.py'
npm run typecheck
npm test
npm run build --workspace @josi-ce/web
bash scripts/scan-secrets.sh
```

Local acceptance accepts an immutable local image ID only when the host helper
is explicitly constructed in development mode. The systemd service does not
enable that mode. Its temporary test project is isolated from the installed
Josi stack. Model locks check both SHA-256 and byte size, runtime locks include
transitive dependencies and wheel hashes, and the base image uses an OCI digest.
