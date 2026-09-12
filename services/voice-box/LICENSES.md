# Voice Box redistribution review

Reviewed 2026-09-12. This is a release candidate, not an authorized public image.
The production image catalog is intentionally empty. No models are fetched by
the running gateway, and no third-party TTS web service receives audio or text.

## Engines, weights and voices

| Component | Pinned artifact | Terms and evidence | Packaging decision |
| --- | --- | --- | --- |
| Kokoro neural model | v1.0 quantized ONNX; revision `1939ad2a8e416c0acfeecc08a694d14ef25f2231` | [Converted model repository](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/1939ad2a8e416c0acfeecc08a694d14ef25f2231) and [original model card](https://huggingface.co/hexgrad/Kokoro-82M/blob/f3ff3571791e39611d31c381e3a41a3af07b4987/README.md) declare Apache-2.0 | Bundle with model cards, attribution and Apache license |
| Kokoro Heart and Bella voice vectors | `af_heart.bin`, `af_bella.bin`, same converted revision | Included in the same Apache-2.0 model repository; the original model card describes the training provenance and attribution | Bundle only these two reviewed vectors, each separately SHA-256 pinned; no voice cloning |
| Kokoro inference | ONNX Runtime 1.22.1 | [MIT](https://github.com/microsoft/onnxruntime/blob/v1.22.1/LICENSE) | Keep wheel license and third-party notices |
| English pronunciation | Misaki 0.9.4, spaCy 3.8.7, `en_core_web_sm` 3.8.0 | [Misaki Apache-2.0](https://github.com/hexgrad/misaki/blob/main/LICENSE), [spaCy MIT](https://github.com/explosion/spaCy/blob/v3.8.7/LICENSE), [English model metadata](https://huggingface.co/spacy/en_core_web_sm) | Pin tagger wheel and retain its MIT license and corpus attribution; dictionary-based pronunciation with spelling for unknown words |
| Speech recognition engine | faster-whisper 1.2.1; CTranslate2 pinned in runtime lock | [faster-whisper MIT](https://github.com/SYSTRAN/faster-whisper/blob/v1.2.1/LICENSE), [CTranslate2 MIT](https://github.com/OpenNMT/CTranslate2/blob/master/LICENSE) | Keep installed notices |
| Speech recognition weights | Whisper Base English revision `3d3d5dee26484f91867d81cb899cfcf72b96be6c` and Tiny English revision `0d3d19a32d3338f10357c0889762bd8d64bbdeba` | [Base model MIT](https://huggingface.co/Systran/faster-whisper-base.en), [Tiny model MIT](https://huggingface.co/Systran/faster-whisper-tiny.en), [original Whisper MIT](https://github.com/openai/whisper/blob/main/LICENSE) | Bundle with model card, immutable revision and file checksums |
| Voice activity detection | Silero model bundled in faster-whisper 1.2.1 | [Silero MIT](https://github.com/snakers4/silero-vad/blob/master/LICENSE); wheel is checksum-pinned | Keep upstream notice for bundled model |
| Piper fallback engine | Optional Piper 1.3.0 | [GPL-3.0](https://github.com/OHF-Voice/piper1-gpl/blob/v1.3.0/COPYING) | Separate from Kokoro; public redistribution requires complete corresponding source and bundled dependency notices |
| Piper LJ Speech voice and model | `en_US-ljspeech-medium`, repository revision `1162a9173d0ce503555aed757976b7a9912eae4c` | [Voice-specific model card](https://huggingface.co/rhasspy/piper-voices/blob/1162a9173d0ce503555aed757976b7a9912eae4c/en/en_US/ljspeech/medium/MODEL_CARD), [repository MIT terms](https://huggingface.co/rhasspy/piper-voices), [public-domain dataset declaration](https://keithito.com/LJ-Speech-Dataset/) | Only this voice is reviewed; the repository's global label alone is not used to approve other voices |

`models.lock.json` records the exact URL, revision, size, SHA-256 and license
for every included model/voice/provenance file. `download_models.py` rejects
changed bytes or length before activating the artifact. The selected models
permit redistribution under the terms above, so a separate end-user download
and license acceptance is not needed for them. Any future voice with restricted
or ambiguous terms must stay out of the image/catalog; adding it requires an
explicit first-install notice and a checksum-pinned download after acceptance.

## Runtime and operating-system dependencies

`requirements.lock` pins every Python dependency and accepted artifact hashes.
The Python base image is pinned by OCI index digest. No floating runtime or
model download is performed at service startup. Upstream copyright files in
installed distributions and the operating-system base must be preserved.

The dependency review found copyleft components beyond the speech engines:
`num2words` (LGPL), `certifi` and `tqdm` (MPL terms), and native libraries bundled
by PyAV/FFmpeg and CTranslate2. In particular, the PyAV wheel's top-level BSD
license does **not** license its bundled codecs. Inspecting the pinned amd64
wheel reports LGPL-3.0-or-later for FFmpeg and includes native codec libraries
with their own terms, including GPL codecs. These require the exact matching
source/build material and notices when redistributed. Do not describe the
whole container as MIT or Apache-only.

Before authorizing a public image, archive the complete corresponding source
and build instructions for all copyleft binary dependencies for each target
architecture, retain all other notices, generate the final image SBOM, and
review that SBOM against this record. A source URL or package-level metadata
alone is not a substitute for corresponding source. The release catalog stays
closed until this artifact-level check and owner release authorization occur.
The application itself is AGPL-3.0-or-later; its source must accompany releases.

The optional Piper runtime carries an internal text-to-phoneme library. It is
not a speech engine choice, is never called by Kokoro, and does not synthesize
Josi's product voice. The earlier standalone speech executable and its package
installation have been removed. The exact Piper v1.3.0 source and its pinned
phonemizer source (`212928b394a96e8fd2096616bfd54e17845c48f6`, the revision specified
by Piper's own CMake build) are checksum-locked and included under
`/models/sources/`. Piper's installed distribution retains the GPL COPYING text.
Preserve both source archives and the upstream build instructions when shipping
Piper; its wheel's engine license does not remove its dependency obligations.
