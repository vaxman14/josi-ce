# Backups and restore tests

Josi creates a PostgreSQL archive in its internal `/data/backups` volume first,
then Restic can copy that archive to a second destination. A backup is not
marked as restore-tested merely because upload succeeded: **Test off-host
restore** reads the archived bytes back from Restic and requires their SHA-256
checksum to match the original.

The installation master key is deliberately never included. Store
`secrets/master.key` separately from both the host and the backup repository.

## Destinations

- **Local disk:** mount the host directory with `JOSI_BACKUP_TARGETS_DIR`; use a
  repository such as `/backup-targets/josi`.
- **NAS:** mount the SMB/NFS share on the Docker host, point
  `JOSI_BACKUP_TARGETS_DIR` at that mount, and use `/backup-targets/josi`.
  Josi does not mount network shares or store NAS passwords itself.
- **Amazon S3:** `s3:https://s3.<region>.amazonaws.com/<bucket>/<path>`
- **Cloudflare R2:**
  `s3:https://<account>.r2.cloudflarestorage.com/<bucket>/<path>`
- **Backblaze B2:** `b2:<bucket>:<path>`

## Credential files

Choose a safe secret reference in the UI, for example `primary`. Files live in
`JOSI_BACKUP_SECRETS_DIR` (default `./secrets/backups`) and are mounted read-only.
Set mode `0600`; never commit them.

Every destination requires `primary_restic_password`. S3 and R2 also require
`primary_access_key_id` and `primary_secret_access_key`; B2 requires
`primary_account_id` and `primary_account_key`.

The values never enter PostgreSQL, HTTP responses, logs, or process arguments.
Restic receives provider credentials only in its child-process environment and
the repository password as a file path.

## Scheduling and retention

The default UI schedule runs daily at 03:00 UTC and keeps 7 daily, 4 weekly,
and 6 monthly snapshots. The worker creates the database archive, initializes a
new Restic repository when necessary, uploads it, applies `forget --prune`, and
runs `restic check --read-data-subset=5%`. Failures remain visible in backup
agent history with a coarse category and no provider error text.
