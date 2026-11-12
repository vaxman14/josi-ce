# Josi in one Docker container

The same Linux server the one-command installer sets up, in a Debian 13
container with systemd: the package, its six isolated services, the web
updater, PC control and Josi's own browser. The container is the computer Josi
controls: she acts as its `josi` user.

## Build

Put the package for the machine's processor (from a release folder) next to
these files: `josi_<version>_amd64.deb` for Intel and AMD, or
`josi_<version>_arm64.deb` for ARM (a Raspberry Pi 4 or 5 with a 64-bit
system, an ARM cloud server). Docker picks the one that matches.

```bash
docker build -t josi:latest .
```

## Run

```bash
docker run -d -t --name josi --restart unless-stopped --privileged --cgroupns=host \
  -v josi-data:/var/lib/josi -v josi-pc:/var/lib/josi-pc \
  -v josi-etc:/etc/josi -v josi-home:/home/josi \
  --add-host host.docker.internal:host-gateway \
  -p 8080:8080 -e JOSI_HOST_ADDRESS=<this machine's address> josi:latest
docker logs josi          # after about a minute: the one-time setup link
```

Open the link (it works once, for 10 minutes), then set Josi up in the browser
like any install. For a new link: `docker restart josi`, wait a minute, then
`docker logs josi 2>&1 | grep "Open this" | tail -1`.

The run line needs `-t`: without a terminal a container has no console and
`docker logs` stays empty. The link is always in the container's own journal:
`docker exec josi journalctl -u josi-firstboot -o cat | grep "Open this" | tail -1`.

Or with Compose, from this folder: set `JOSI_HOST_ADDRESS` in the environment
(or in a `.env` file beside `docker-compose.yml`) and run `docker compose up -d`.

| Variable | Default | |
|---|---|---|
| `JOSI_HOST_ADDRESS` | the container's address | what people type to reach this machine |
| `JOSI_HOST_PORT` | `8080` | the port you published for 8080 |
| `JOSI_PC_CONTROL` | `1` | `0`: Josi may not control the container |
| `JOSI_BROWSER` | `1` | `0`: no hidden-screen Chrome |

## A model on the same machine

With the `--add-host` line above, a model server running on the Docker host is
`http://host.docker.internal:<port>` from inside the container. For Ollama:

- Ollama must listen on the Docker bridge address, not only on 127.0.0.1
  (for example `OLLAMA_HOST=172.17.0.1:11434` in its service settings).
- In Josi (setup, or Admin, Model) pick "A model on your own hardware", address
  `http://host.docker.internal:11434/v1`, no key.
- If the model thinks before it answers (Qwen 3 and relatives), set
  "Thinking" to "Off". Josi then sends `reasoning_effort: "none"` with every
  request. Left on, such a model can come back empty after using a tool.

## Notes

- `--privileged` and `--cgroupns=host` are needed because the services use
  systemd sandboxing and the web updater works as in a real install.
- The four volumes hold everything: the database and settings, Josi's browser
  and PC identity, the `josi` user's files. Removing the container keeps them.
- Chrome runs without its own sandbox here; the container is the sandbox.
- Josi changes only this container, never the host.
- Updates: the web updater works as on a real install, or build a new image
  from a newer `.deb` and run it on the same volumes (it upgrades in place).
