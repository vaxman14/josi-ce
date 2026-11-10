# Windows client and node spec (November 10, 2026)

The Josi Client for Windows is the same app as Josi for Windows without the
server. It talks to a Josi server somewhere else and does everything the
signed-in person may do there, from chat and from settings. It is also a node:
the server can control the PC the client is installed on.

The owner's five decisions:

1. **Reach.** A direct HTTPS address, pairing through heyjosi.com, and the
   local network.
2. **Approving the node.** Signing in as a registered user approves the PC
   automatically, after Windows asks for elevation. Sign-in proves the user,
   elevation proves the computer's administrator.
3. **Who controls which PC.** The person signed in on that PC. A member
   controls only the PCs enrolled under their own account, and uses the server
   only within their own permissions. The owner is no exception: the owner
   controls the owner's PCs, not a member's.
4. **Window closed.** Josi keeps running in the tray. A setting, on by
   default. A second setting starts Josi when the person signs in to Windows.
5. **Settings shown.** Everything the signed-in person is allowed to use.
   Nothing is hidden because the app is the client edition; only things that
   need the server's own machine are.

## What never lives in the client

The Vault, the database, models, the mail and file stores. Secrets go from a
card straight to the server with the person's own session. The client stores
one session token per server in Windows Credential Manager and one executor
key per server and user in the Windows key store.

## Server

- `users.pc_control_allowed` (migration 0123, default true). The owner turns
  it off per member with `PATCH /admin/users/:id {pcControlAllowed}`. The
  owner is never gated. `/auth/me` and sign-in return `pcControlAllowed`.
- `/admin/pc-control/*` needs a signed-in user who is allowed PC control, not
  the owner role. Every row is already keyed by user and PC, so a member sees
  and controls only their own PCs. The path keeps its name for old clients.
- `POST /admin/pc-control/identity` accepts either the account password (as
  before) or `{elevated: true}` on a session created at most ten minutes ago
  by an interactive sign-in. The executor's signed proof is required in both.
- The agent offers PC tools, the permission list and permission cards to any
  allowed user for their own PCs. A PC permission card can be applied only by
  the person it was proposed for.

## Client

- **Enrolment.** After an interactive sign-in, if this PC is not approved for
  this server and user, the client starts itself elevated
  (`--node-approve`). Windows shows its own prompt. The elevated copy records
  the approval under `HKLM\SOFTWARE\Josi\Nodes` (server, user, key
  fingerprint) and exits; the client then enrols the key with
  `{elevated: true}`. Declined or failed: nothing is enrolled and
  "Approve This PC" stays in PC Control and in chat. A remembered sign-in
  older than ten minutes falls back to the password prompt.
- **Node loop.** Runs for any signed-in user who is allowed PC control.
- **Reach.** The address field takes `https://…`, a bare host name or a LAN
  address (`192.168.1.20:8443` becomes `https://192.168.1.20:8443`). A server
  on the local network with a self-signed certificate is trusted by pinning
  its fingerprint after the person confirms it once. Plain HTTP stays
  loopback only. Pairing through heyjosi.com uses the existing tunnel code
  and is switched on by the `RELAY_ENABLED` build constant.
- **Launch.** The client reconnects to the last server it was signed in to.
- **Tray.** "Keep Josi running when I close the window" and "Start Josi when
  I sign in to Windows" under Settings, "Josi on this PC", both on by default. Started by Windows,
  Josi opens in the tray without a window.
- **Sections.** Shown by what the person may use. `server` and `network`
  need the server's own PC and stay with the server edition.

## Not done here

- relay.heyjosi.com does not answer, so pairing through heyjosi.com cannot be
  tested and the client build ships with it off.
- A People screen switch for `pcControlAllowed`; today it is set through the
  route (or by asking Josi once a tool exists).
- The elevation step is the client's own check: the server cannot verify
  that Windows asked. It is recorded on the PC under `HKLM`.
- Not driven live yet: the Windows elevation prompt, the tray-only start at
  sign-in, and a member (not the owner) enrolling a PC.
