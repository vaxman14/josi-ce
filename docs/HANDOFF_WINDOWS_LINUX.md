# Handoff: build Josi CE for Windows, then Linux

You're building the Windows installer first, then the Linux packages, from the Hey Josi redesign. You have no earlier context, so this page is everything you need.

## Rules from the owner
- Plain words. Say when a build is ready or what stopped it, with the exact error.
- Never type, read or store passwords, tokens or secrets. Signing sign-ins are the owner's.
- No pull requests and no merges. Ask before pushing.
- **Do not attach anything to the GitHub release.** Draft `v1.0.0` already holds the older installers from before this redesign, and the owner publishes it. Leave out `-Publish` and `--publish`.
- Don't deploy, and don't change DNS or live Stripe, Cloudflare or Google settings.

## Get the code
```bash
git fetch origin hosted/relay-accounts-20261105
```
```bash
git checkout hosted/relay-accounts-20261105
```
If the fetch finds no such branch, it hasn't been pushed yet. Stop and tell the owner. Read `docs/APP_REBUILD_HANDOFF.md`, `docs/RELAY_PROTOCOL.md`, `docs/WINDOWS_RELEASE.md` and `docs/LINUX_RELEASE.md`.

## What's new
Every device reaches the user's server through one end-to-end encrypted connection (Noise IK), via a relay that only forwards sealed bytes, or directly on the LAN on port 18777. It's off until a server is linked. New pieces: `packages/tunnel`, `apps/api/src/relay`, `apps/hosted`, `services/relay`, migrations 0111 to 0113, and `apps/windows-native/src/Tunnel*.cs`. The build scripts find packages by folder, so they need no change for `packages/tunnel`.

## Fix this first, on both platforms
**The web service probably can't create its key folder.** The server keeps its keys in `<data>/keys` when no OS key store works, which is likely for a service account. The installers lay out the data folder from fixed lists, and the data root isn't writable by the service. Nothing has tested this on a real install.
- **Windows:** add `keys` to `packaging/windows/DataLayout.psm1`, with `$web` as the only account with access, like `chat-attachments`.
- **Linux:** add `keys` for the web role in `packaging/linux/lifecycle.py`, mode 0700, owned by `josi-ce-web`.
- Add a test beside the existing layout tests, and report what you changed. Only the web service needs this folder. The worker uses a separate key from the database.

## Part 1: Windows
Machine needs: Git, Node 24, .NET SDK 8, Visual Studio Build Tools with the Windows 10 SDK, the gh CLI, and the voice Python from `scripts\windows\Prepare-VoiceSpike.ps1`. See `docs/WINDOWS_RELEASE.md` for all of it. The usual folder is `C:\Dev\josi-ce`.

1. Test the Windows tunnel code. It has passed on macOS only. This needs a .NET 8 SDK and Node, and `run.sh` needs a shell such as Git Bash:
```bash
apps/windows-native/test/tunnel-console/run.sh
```
2. Build, unsigned and local:
```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\Build-Release.ps1 -Version 1.0.0
```
Add `-Sign` only once the owner has done `az login`. Output: `artifacts\windows-native\releases\1.0.0\`.
3. Check it without installing:
```powershell
.\Josi-CE-1.0.0-Windows-x64.exe /VERIFYONLY /CURRENTUSER
```

**Expect:** a licence or SBOM check may flag the new packages `ws` and `@noble/*`. The service-host hash is per machine, see `docs/WINDOWS_RELEASE.md`. Some files are CRLF, including `AppModel.cs`, so keep their line endings.

**Check on a real install. None of this has ever run:**
- The app opens, and the pairing sheet and "Change This PC's Key" work. The WPF app has been compiled but never launched.
- The Hey Josi page shows where the key is stored. The Credential Manager code uses `koffi` and has never run, and it may not work for `NT SERVICE\JosiWeb`. Falling back to the file is fine.
- The `keys` folder isn't readable by other accounts. The file store can't check ACLs on Windows, so the layout has to.
- No firewall rule is added for port 18777. Other devices silently use the relay. Say whether you think the installer should add one, and don't add it without asking.

## Part 2: Linux
This needs x86_64 Linux with Docker, Node 24, npm, Python 3 and `zstd`. It can't run on Windows itself. Use WSL2 with Docker if this machine has it and it works. Otherwise the documented build host is Bananana (10.10.1.4), which has the tools, except that its Node is 26: check with the owner before using a different version. Bananana also runs live sites, so ask before starting a long build there.

```bash
python3 -m unittest discover -s packaging/linux -p 'test_*.py'
```
```bash
scripts/linux/build-release.sh --version 1.0.0
```
Output: `<build base>/releases/1.0.0/`. See `docs/LINUX_RELEASE.md` for the build folders and AppImage tools. Add `--skip-provision` on later runs.

Then run the isolated install test, which starts all services without touching this machine's systemd:
```bash
scripts/linux/test-isolated-install.py <staged runtime> <disposable root>
```

**Expect:** `apps/hosted/dist` gets staged by the `apps/*/dist` glob. It holds no secrets and never runs there, so exclude it if that's easy. On a headless server there's no Secret Service, so the file store is expected.

## Testing the connection
The live relay isn't deployed, so typed pairing codes can't work yet. Use a pairing link and a local relay. Port 8787 is taken on the owner's Mac, so use 8799:
```bash
cd services/relay && npm install && npx wrangler dev -c wrangler.dev.toml --port 8799 --ip 127.0.0.1
```

## When you finish
Report for each platform: the files built with their sizes and SHA-256, every check you ran and its result, what you changed, and what you couldn't test. Commit to the branch only if the owner says so.
