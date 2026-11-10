# PC control on the Linux server

The Linux server is headless, so the Windows app's executor (the part of
Josi.exe that runs commands, files, programs, windows and the browser) is a
service of its own: `josi-pc.service`, the Node script
`packaging/linux/pc-executor/josi-pc.mjs`. It speaks exactly the same
executor protocol as Windows (`apps/api/src/http/pcControlRoutes.ts`): a
P-256 key, signed `/executor/*` requests, presence every 10 seconds, one
claimed request at a time under a 1.5-second lease, results capped at 256 KB.

## Who it runs as

The installer asks "Let Josi control this computer?" and which Linux user
(default: the user who ran `sudo`). The service runs as that user, with that
user's home, files and permissions, never as root. Administrator commands are
refused on Linux; `sudo` inside a command works only if that user has
passwordless sudo, and `pc_environment` says whether it does.

## Pairing without a sign-in window

1. On start the service makes its key and PC id (`linux-<32 hex>`) in
   `/var/lib/josi-pc` (0700) and writes `<pcId>.hello.json` into the spool,
   `/var/lib/josi/data/pc-spool` (root:josi-pc 2770). Only the web service and
   this service are in group `josi-pc`.
2. The server lists that PC for the owner (`syncLocalExecutors`,
   `packages/core/src/pcLocalExecutors.ts`), so chat can offer it before it is
   paired.
3. The owner asks Josi to control the server. Josi proposes
   `pc_control_enabled`; approving the card with the password also pairs the
   service (`apps/api/src/http/pcLocalPairing.ts`): the hello's key becomes the
   PC's executor identity and a one-year owner session is written as
   `<pcId>.ticket.json` (0640). The PC Control page has the same Pair button.
4. The service takes and deletes the ticket and starts announcing itself.
   Unpair (page or `josi-pc.mjs unpair`) revokes the session and the key.

## What works

| Request | Linux |
|---|---|
| `pc_environment` | user, home, XDG folders, OS, shells (bash, sh, zsh), tools, disks, desktop session, passwordless sudo |
| `pc_run_command` | bash (default), sh, zsh; process group killed on timeout, stop or revoke |
| `pc_terminal_*` | a real pseudo-terminal (Python `pty`, 120x36), 256 KB ring, lease-watched |
| `pc_list_folder`, `pc_read_file`, `pc_write_file` | no symbolic links, no hard links, Josi's own folders refused, sha256 check on write |
| `pc_find_app`, `desktop_launch` | `.desktop` entries and PATH programs |
| windows, screenshot, click point, type, keys, scroll, drag, close | when the user has an X11 session and `xdotool` (+ ImageMagick for pictures); controls are not exposed, so Josi works from screenshots |
| browser tools | the Josi browser extension with a natively packaged Chrome, Chromium, Edge, Brave or Firefox on the same machine (`browser.mjs`, `josi-browser-host.mjs`) |

On a server with no desktop the screen tools answer
`control_surface_unavailable` and everything else works.

## Commands on the server

```bash
sudo systemctl status josi-pc
sudo -u <user> /var/lib/josi/versions/<v>/node/bin/node /var/lib/josi/versions/<v>/app/packaging/linux/pc-executor/josi-pc.mjs status
```

`pause` / `resume` stop and restart taking work (the pause file lives in the
state folder, like the Windows app's).

## Known gaps

- Wayland-only desktops: `xdotool` reaches only XWayland windows.
- Snap and Flatpak browsers start native hosts confined; only packaged browsers link.
- No ghost control bar on the server itself; work shows in the web chat.
