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
| `JOSI_PUBLIC_URL` | none | the `https://` address when Josi is published through a tunnel or your own proxy (see below) |
| `JOSI_PC_CONTROL` | `1` | `0`: Josi may not control the container |
| `JOSI_BROWSER` | `1` | `0`: no hidden-screen Chrome |

## Upgrading, or starting again with other options

Remove the container and run the new image with the same volumes:

```
docker rm -f josi
docker run ... (the same line, with the new image or the new options)
```

Josi's service accounts and service files live in the container, not in the
volumes, so a new container starts without them. `josi-firstboot` puts them
back from what the data volume records (`josi-adopt.py`: the same numeric ids
as before, units for the version the data last ran with), and the installer
then upgrades or simply starts Josi. Images before 1.2.8-beta.30 do not do
this by themselves and report "Josi did not start"; pipe the script in once
and restart: `docker exec -i josi python3 - < josi-adopt.py && docker restart josi`.

## A model on the same machine

With the `--add-host` line above, a model server running on the Docker host is
`http://host.docker.internal:<port>` from inside the container. For Ollama:

- Ollama must listen on the Docker bridge address, not only on 127.0.0.1
  (for example `OLLAMA_HOST=172.17.0.1:11434` in its service settings).
- In Josi (setup, or Admin, Model) pick "A model on your own hardware", address
  `http://host.docker.internal:11434/v1`, no key.
- "Thinking" is Off unless you change it: Josi sends `reasoning_effort: "none"`
  with every request. With thinking on, Qwen 3 and its relatives answer slowly
  and can come back empty after using a tool.
- "Prompt size" is Automatic: Josi asks Ollama what context the model runs
  with (`num_ctx`) and uses its compact prompt, about 5,000 tokens a request,
  when that is under 32,000. Josi cannot raise `num_ctx` itself; it is set on
  the model in Ollama. Admin, Model, "Size and speed" shows the context, the
  size of the last request split into instructions, tools and conversation, and
  every recent request with its tokens and seconds.
- A model that cannot see pictures still gets their text: Josi reads pictures
  and scanned PDFs on this server (OCR, English) and says so in the reply.

To record the exact request and raw reply of every model call, for debugging:

```
docker exec josi touch /etc/josi/llm-debug      # on, no restart
docker exec josi sh -c 'tail -n 2 /var/lib/josi/data/logs/worker/llm-debug/model-calls.jsonl'
docker exec josi rm /etc/josi/llm-debug         # off
```

Chat replies are made by the worker service, the model test by the web
service (`.../logs/web/llm-debug/`). The file holds conversations; turn it off
when you are done.

## Behind a tunnel or your own proxy

When people reach Josi at an `https://` name that something else serves (a
Cloudflare tunnel, nginx, Caddy on the host), start the container with that
name and point the tunnel at `http://localhost:8080`:

```
docker run ... -e JOSI_PUBLIC_URL=https://josi.example.com ... josi:latest
```

The setup link, emailed links, sign-in redirects and phone pairing then use
that address, and sign-in cookies are marked Secure. Two consequences: signing
in at the plain `http://<LAN address>:8080` stops working (use the https name,
or `http://localhost:8080` on the machine itself), and the variable has to
stay on the container, because the address is applied at every start. To
change an existing container, remove it and run it again with the variable;
the data volumes stay.

Before the first account exists, the only thing an outside visitor can do is
load the sign-in page: every setup request needs the one-time link printed in
the container's log, which is random, works once and expires after ten
minutes. Finish setup before you tell anyone the address.

## Notes

- `--privileged` and `--cgroupns=host` are needed because the services use
  systemd sandboxing and the web updater works as in a real install.
- The four volumes hold everything: the database and settings, Josi's browser
  and PC identity, the `josi` user's files. Removing the container keeps them.
- Chrome runs without its own sandbox here; the container is the sandbox.
- Josi changes only this container, never the host.
- Updates: the web updater works as on a real install, or build a new image
  from a newer `.deb` and run it on the same volumes (it upgrades in place).
