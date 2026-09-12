# Voice Box validation

Validated on Linux amd64 on 2026-09-12, against canonical `origin/main`
`aa66b23`. These are local development builds; no image, release, deployment,
release workflow dispatch, or upgrade gate was published or changed.

| Check | Result |
| --- | --- |
| Full `npm test` | 86 files, 2,305 tests passed |
| `npm run typecheck` | Passed, including web type checking |
| Web production build | Passed |
| Host helper Python tests | 10 passed: allowlists, isolation, private credentials, readiness, rollback, checksum rejection, CPU/GPU selection |
| Real CPU image acceptance | 11 passed: model inference readiness, actual container isolation, authentication, streaming STT/VAD, Kokoro Heart/Bella, Piper, Tiny STT, rollback, restart, uninstall |
| Focused browser acceptance | Passed: install/readiness controls, engine/voice selection, WAV preview, mobile layout, microphone capture, partial/final transcript, assistant reply, interruption, microphone track cleanup |
| CE application Docker build | Passed, local image only |
| Optional GPU image build | Passed; GPU inference not verified because this host lacks NVIDIA Container Toolkit/CDI configuration |
| Existing full browser suite | 58 passed, 10 failed; identical counts and assertions reproduced on untouched `aa66b23` using the same fixture and official Playwright 1.62.1 container |

The existing browser failures concern console assertions, existing control sizes,
connection/provider expectations, admin header and branding/offline assertions.
They also fail without this change. The full browser gate is therefore **not
green**, and this branch does not weaken those assertions or upgrade any gate.

## Reproduce

Run the commands in [Voice Box development and verification](VOICE_BOX.md#development-and-verification).
After building the API and web app, run `node scripts/test-voice-browser.mjs`
for the focused browser acceptance; add `--full` to include the existing suite.
The browser fixture uses the actual Josi API and UI with deterministic helper
and assistant responses. `scripts/test-voice-box.py` separately exercises the
actual container, pinned models and real inference, including STT of synthesized
speech. Neither test is a claim that live microphone acoustics were evaluated
on every browser or device.

## Publication boundary

The production image catalog remains empty until owner authorization and the
artifact-level redistribution obligations in [LICENSES.md](../services/voice-box/LICENSES.md)
are satisfied. Engine/model/voice licenses have been reviewed and artifacts are
checksum-pinned. Complete corresponding source/build material for all bundled
native copyleft dependencies and the final per-architecture SBOM remain required
before public binary distribution. Source review can proceed independently.
