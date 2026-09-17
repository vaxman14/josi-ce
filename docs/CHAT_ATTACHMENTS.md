# Chat attachments

Chat uploads use the dedicated `josi_chat_attachments` persistent volume mounted
at `/data/chat-attachments`. Web and worker run as UID/GID 1000. A one-shot
`attachment-init` service repairs only the volume directory's ownership and mode
on installation and upgrades; it has no network, host mounts, or secrets.
Container recreation preserves the volume. Never delete this volume to upgrade.

The limits are 20 MB per file, one file per upload request, 10 attachments per
message, 100 files per conversation, 1,000 files/200 MB per user, and
10,000 files/2 GB per installation. Database reservations serialize concurrent
uploads so separate web processes cannot bypass quotas. Empty files are refused.
Names are normalized and stripped of path/control characters; server UUIDs,
not filenames, address stored bytes. Duplicate display names are supported.

Supported types are UTF-8 text/Markdown/CSV/TSV/JSON/XML/HTML, PDF, DOCX/XLSX/PPTX,
ODT/ODS/ODP, PNG/JPEG/WebP/BMP/TIFF. Extensions, declared MIME and content signatures
must agree. Executables, scripts, SVG, macro formats, embedded Office binaries,
active PDF actions, oversized expanded Office archives, and recognizable credential
files are refused. This validation is not a claim of antivirus certification.
Uploaded content is never executed. Downloads use attachment disposition,
`nosniff` and a sandbox content policy, including HTML files.

Native `.heic` and `.heif` photos are also accepted. Josi verifies the
ISO-BMFF/HEIF signature rather than trusting the filename or MIME type, converts
the primary image to JPEG in an isolated worker, and stores the JPEG for previews
and vision-capable model providers. Original HEIC bytes are not retained. Corrupt
or disguised files, timed-out conversions, and images exceeding 20 MB after
conversion are rejected with an actionable message.

Only the conversation owner can upload, retrieve or delete attachments. Model
selection checks both owner and conversation. A file is unavailable until its
write succeeds. Image bytes are supplied only to a model with verified vision
capability; other supported files contribute extracted text. This sends the
selected content to the configured model provider under that provider's privacy
terms. Contents and original names are excluded from attachment audit events.

Unsent uploads expire after 24 hours; the worker sweeps hourly. Files referenced
by conversations are preserved, including references created before upgrading.
An attachment already handed to a model is conservatively retained even if the
model call fails. Deletion of an unused attachment is available through
`DELETE /api/assistant/attachments/:id`; referenced attachments return 409.
Files left behind by a deleted conversation or failed database write are removed
after the same 24-hour safety window. Back up the attachment volume together with
the database to preserve conversations containing files.

If `/ready` reports `attachment_storage`, inspect the web/worker startup diagnostic:

- `storage_missing`: provision the named volume and recreate web/worker using the
  release's Compose definition, including `attachment-init`.
- `storage_permission`: rerun `docker compose run --rm attachment-init`, then
  check that web/worker run as UID 1000.
- `storage_read_only`: restore read/write access to the dedicated attachment volume.
- `storage_full`: free disk capacity; deleting a container does not free a volume.
- `storage_unsafe`: remove a symlink configuration and mount a real dedicated volume.

Quota and file-type failures explain their own limits in the chat error message.
Readiness exposes only the subsystem name, never host paths or raw filesystem
errors. An unavailable volume must be repaired; restarting the app alone does
not provision a missing persistent mount.
