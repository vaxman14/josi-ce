# Install Josi CE

Josi CE runs in Docker. You do not need Git, Node.js, a source checkout, or a
command-line management tool.

Before you start, install and open Docker:

- **Mac:** [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/)
- **Linux:** [Docker Engine](https://docs.docker.com/engine/install/)

Use a 64-bit Intel/AMD or ARM machine with at least 2 GB of memory and 5 GB of
free disk space.

## 1. Run the installer

Choose the command for your computer and paste the whole block into Terminal.

### Mac

```bash
JOSI_HOST_IP="$(ipconfig getifaddr "$(route -n get default | awk '/interface:/{print $2;exit}')")" && \
test -n "$JOSI_HOST_IP" && \
mkdir -p "$HOME/josi-ce" && cd "$HOME/josi-ce" && \
docker run --rm \
  -e JOSI_INSTALLER_HOSTNAME="$JOSI_HOST_IP" -p 8080:8080 \
  -v "$HOME/.docker/run/docker.sock:/var/run/docker.sock" \
  -v "$PWD:$PWD" -w "$PWD" \
  docker.io/romanvaxman/josi-ce-installer:latest
```

### Linux

```bash
JOSI_HOST_IP="$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++)if($i=="src"){print $(i+1);exit}}')" && \
test -n "$JOSI_HOST_IP" && \
mkdir -p "$HOME/josi-ce" && cd "$HOME/josi-ce" && \
docker run --rm \
  -e JOSI_INSTALLER_HOSTNAME="$JOSI_HOST_IP" -p 8080:8080 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD:$PWD" -w "$PWD" \
  docker.io/romanvaxman/josi-ce-installer:latest
```

The installer prints one private setup link using the computer's LAN address.
Leave the Terminal window open while setup is running. The same link works from
another device on the local network, including a headless Josi server. It never
uses Docker Desktop's hidden Linux-VM address.

The temporary installer can control Docker so it can create the Josi services.
It exits when installation finishes. The normal Josi services do not receive
the Docker socket.

## 2. Finish setup in your browser

1. Open the setup URL printed in Terminal.
2. Accept the temporary local-certificate warning.
3. The private link connects to the installer automatically.
4. Choose how people will reach Josi entirely in the browser:
   - this computer only;
   - devices on your local network;
   - a public domain with automatic HTTPS; or
   - an existing reverse proxy or tunnel.
5. Optionally choose one project folder for Josi to access. Skip this unless
   you want coding features to work with local files.
6. Review the choices and select **Install Josi**.

The browser installer writes the configuration, generates the installation
secrets, downloads the published images, starts Josi, and checks that it opens.
You do not edit `.env`, run Compose, or use the Josi management CLI during the
normal installation path.

## 3. Open Josi

When installation succeeds, select **Open Josi**.

The first person through setup becomes the administrator. Josi then walks you
through the account, AI provider, privacy choices, and optional connections.

When Josi shows the recovery key:

1. Select **Copy key** or **Download key**.
2. Store it somewhere other than the Josi computer.
3. Confirm that you saved it.

The recovery key is shown once. The setup page handles this step; there is no
separate command to generate or copy it.

## 4. Confirm it works

Open the Josi URL and send a message.

That is the installation check. If the page opens and Josi answers using the
provider configured during setup, the installation works. You do not need to
inspect containers or call health endpoints.

## After installation

Use Josi's **Admin** screens for normal management:

- **Overview** shows installation status and recommendations.
- **System checkup** runs Josi Doctor, explains problems, offers bounded automatic repairs, and installs approved stable updates with backup and health verification.
- **Network & address** changes local, LAN, domain, proxy, or tunnel access.
- **Backups** creates backups and configures storage destinations.
- **Integrations** connects AI providers and external services.
- **Users** manages access to the workspace.

Keep Docker running. On a dedicated Mac mini, enable Docker Desktop at login so
Josi returns after a restart.

## Use Josi on your devices

Your Josi server is the home for every client. The web app and native apps use
the same account, workspace, conversations, memory, and tools.

- **Android:** [Install Josi CE from Google Play](https://play.google.com/store/apps/details?id=com.socalreceptionist.josice).
- **iPhone and iPad:** The App Store release is coming soon.
- **macOS, Windows, and Linux:** Desktop downloads are in final device testing.
  Links will appear here when each build is approved.

To connect a native app:

1. Open Josi CE.
2. Choose **Public URL** or **Tailscale**.
3. Paste the Josi URL shown during server setup.
4. Select **Verify and continue**.
5. Sign in with the same Josi account you created in the browser.

The app connects to the Josi server you just installed. It does not install or
create another server.

## Updating Josi

Open **Admin → System checkup** as a super-admin, select **Check for updates**,
review the release notes, enter the exact confirmation shown, and approve the
update. Josi creates a backup, applies the pinned release, verifies health, and
rolls back automatically when a safe rollback is possible.

If Josi cannot open or the maintenance helper is unavailable, run the same
installer command again. The browser installer detects the existing
installation and preserves its configuration and data. Do not delete the
`josi-ce` folder or Docker volumes during an update.

## Backups

Open **Admin → Backups** to create a backup or configure SMB/NFS storage. Keep
the recovery key separately from the backup destination. A backup and the key
protect different things, so you need both.

## Troubleshooting

### Docker is not running

Open Docker Desktop on Mac, or start Docker Engine on Linux, then run the same
installer command again.

### The Mac reports that the Docker socket does not exist

Wait until Docker Desktop says the engine is running, then retry. Josi uses
Docker Desktop's user socket at `$HOME/.docker/run/docker.sock`.

### Port 8080 is already in use

Stop the program using port 8080, then run the installer again. The port is used
only for the temporary setup page.

### The browser warns that the setup page is not private

That warning is expected for the temporary local setup certificate. Confirm
that the address matches the one printed by the installer before continuing.

### Setup was interrupted

Run the same installer command again from the same computer. It reuses the
`$HOME/josi-ce` installation directory and preserves completed configuration.

### Josi installed but does not open

Return to the installer window and use its reported error. If Josi previously
worked, open **Admin → System checkup**. Do not delete Docker
volumes or the installation directory while troubleshooting.

## Source code and licence

Josi CE is licensed under the GNU AGPL v3. The
[source code is available on GitHub](https://github.com/vaxman14/josi-ce).
Licence terms, security reporting, and developer documentation are kept
separate from this end-user installation path.
