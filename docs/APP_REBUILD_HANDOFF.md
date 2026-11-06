# Handoff: rebuilding the apps with the relay

For the session rebuilding the Mac, Windows and Linux installers. It covers how
the Hey Josi redesign works, what's in the code, and what a rebuild has to do and
check.

## Where the code is

- Worktree: `JosiDrive/Projects/worktrees/josi-ce-hosted-relay`
- Branch: `hosted/relay-accounts-20261105`, cut from `windows/native-client-20261020` at `2e2c097`
- Committed on that branch, not pushed. To build from another folder, use the branch from this repo's local refs.
- `macos/native-distribution-20261009` has no commits this branch lacks. Its worktree has 158 uncommitted files from about Oct 21, which nobody has reviewed.

## How it works

Every device talks to the user's server through one encrypted connection, using
`Noise_IK_25519_ChaChaPoly_SHA256`. The relay only forwards sealed bytes.

```
phone, Mac app, Windows app, browser
        |  Noise, end to end
        v
relay (Cloudflare Worker, services/relay)      or straight across the LAN, port 18777
        |  the same sealed bytes
        v
Josi server: TunnelHost -> httpBridge -> its own API on 127.0.0.1
```

- **The tunnel carries normal HTTP.** Each app sends its usual API requests through it, so the API barely knows it's tunnelled.
- **Native apps:** the Mac app uses a `URLProtocol`, Windows a custom `HttpMessageHandler`. `JosiAPI` and `JosiApi` barely changed.
- **Browsers:** at `<user>.heyjosi.com` the relay serves one fixed starter page. It pairs the browser and installs a service worker. After that, every page and API call comes from the user's server through Noise.
- **Sessions:** pairing opens the connection only. People still sign in to Josi. Without a bearer token, the server keeps a cookie jar per device and adds the CSRF token itself.
- **Pairing:** the server makes a 160-bit, 10-minute, single-use code. QR codes carry the server key. Typed codes look up a sealed box on the relay.
- **Hosted service (`apps/hosted`):** accounts, plans, Stripe test mode, the AI gateway, and the Google broker. A server calls it with one sealed exchange per call. It reaches a server as a tunnel peer with a key the server pinned when it was linked.
- **Off by default:** a server that isn't linked opens no listener and contacts nothing.

The wire format is in `docs/RELAY_PROTOCOL.md`. `packages/tunnel/src` is the
source of truth, and a third client should start there.

## What changed for each app

**Server (all platforms).** New package `packages/tunnel`, new dependencies `ws` and `@noble/{curves,ciphers,hashes}`, new migration `0111_hey_josi.sql`, new folder `apps/api/src/relay`, a new `hey_josi` model provider. It also has real fixes unrelated to the relay. See "Existing bugs fixed" below.

**Mac app.** `apps/macos-native/Sources/Tunnel*.swift` and `PairingView.swift`, with edits to `JosiAPI`, `JosiModel`, `JosiApp` and `ServerHealthView`. `NSLocalNetworkUsageDescription` is added in `scripts/macos/build-native-unified.py`.

**Windows app.** `apps/windows-native/src/Tunnel*.cs`, with edits to `JosiApi`, `SessionStore`, `AppModel`, `Screens`, `Dialogs`, `MainWindow` and `Sections`. Windows 10 has no built-in ChaCha20-Poly1305 below build 20142, so a managed one ships in `TunnelCrypto.cs` and is used automatically.

**Web app.** New pages: Devices (`/app/devices`) and Hey Josi (`/admin/hey-josi`), plus an allowance card on Usage. Built into the server as usual.

**Not touched.** `apps/desktop` (the Electron client) has no tunnel. The phone apps aren't done: see below.

## Rebuilding

The build scripts find packages by folder, so `packages/tunnel` is picked up with no script change. Start clean, because the dependencies changed:

```bash
npm ci
```

```bash
npx tsc -b
```

Then run the usual release scripts. Expect these on the way:

1. **Locks and licences.** `package-lock.json` changed, and `packaging/macos/build-inputs.lock.json` lists it. The new dependencies need to pass `scripts/macos/licenses.py` and `scripts/windows/Test-ReleaseSbom.mjs`. None of the release builds have been run on this branch.
2. **`apps/hosted` gets staged too.** The Mac and Linux scripts glob `apps/*/dist`, so the hosted service's compiled code lands in the installers. It has no secrets and never runs there, but it's worth excluding.
3. **Docker.** `Dockerfile` and both compose files changed, with a new `josi_keys` volume so keys survive a recreated container. The image hasn't been built. Docker Desktop isn't on this Mac.
4. **The secret scan fails.** `scripts/scan-secrets.sh` bans `heyjosi.com`, and it was failing before this work. It reports no credentials in the new code, but a hook or release step that runs it will stop. That needs the owner's decision, not a workaround.

## Check these first on real machines

Nothing below has been tested. The top two can break features silently.

1. **Where the server's key ends up.** `openKeyStore` tries the OS store and falls back to a 0600 file in the data folder. The Hey Josi page shows which. If the server runs as a service account, the Keychain or Credential Manager may not work for it, or may behave differently.
2. **Whether the API and worker share that store.** The worker refreshes Google tokens with the same key. Windows services have their own identities, so if they run as different accounts, the OS store won't be shared and refreshes in the worker will fail. Setting `JOSI_KEY_STORE=file` in the runtime config for both is the simple fix.
3. **The LAN listener.** Port 18777, bound to all interfaces once linked. The Windows installer adds no firewall rule, so other devices won't reach it and will silently use the relay. macOS may show a firewall or Local Network prompt.
4. **`koffi` and Credential Manager.** The Windows key store code has never run.
5. **A signed Mac app's Keychain access**, and clicking through the paired-server row and Replace Device Key, which have never been rendered.
6. **The Windows UI.** The whole app compiles against the Windows SDK with 0 errors, using a scratch copy with the icon step removed. It has never been launched.

## Testing without the live relay

The relay isn't deployed, so `relay.heyjosi.com` doesn't exist yet. Both apps hardwire typed-code lookups to it, so **typed codes can't work until it's deployed**, and an owner's own relay has to pair by link.

```bash
cd services/relay && npm install && npx wrangler dev -c wrangler.dev.toml --port 8799 --ip 127.0.0.1
```

Use port 8799. The user's bananana dev relay uses 8787.

Tests that prove each client:

```bash
python3 scripts/macos/test-native-tunnel.py
```

```bash
apps/windows-native/test/tunnel-console/run.sh
```

```bash
JOSI_BROWSER_E2E=1 npx vitest run apps/hosted/test/fullstack
```

The browser test needs that relay running, a fresh `apps/web` build, and Chrome:

```bash
JOSI_BROWSER_E2E=1 npx vitest run packages/tunnel/test/browser
```

## Known limits

- **Phones.** No Josi CE phone app source is in this repo. `vaxman14/josi-app` is an Expo app that talks to OpenClaw, and its README doesn't describe Josi CE. Once the real source is found, `packages/tunnel` is pure TypeScript with no Node needs in `client.ts`, and the Swift `Tunnel*.swift` files should port to iOS.
- **Pairing needs a relay.** A server with no relay can't pair devices. Its own address still works on the LAN.
- **Browsers skip the LAN path.** An https page can't open `ws://` to a LAN address, so browsers always use the relay at the Hey Josi address.
- **No flow control in the mux.** A very large download on a fast path can buffer in memory if the app reads slowly.
- **Server restarts sign out tunnelled devices that have no bearer token,** because the cookie jar is in memory. Windows handles this by asking for CSRF again before each post.
- **Unnamed servers:** the Mac uses `<site>.josi.invalid` as the origin and Windows `<site>.<domain>`, and the Mac prefers the link's own origin. Protected approvals will fail on an unnamed server on Windows. Linked servers always have a name.
- **Usage in the native apps.** The AI allowance shows on the web pages only. Native screens don't show it yet.
- **"Forget" on the Mac** removes the pairing there only. The server keeps its record until someone removes the device.

## Existing bugs fixed along the way

These change behaviour outside the relay, so they deserve a look during the rebuild:

- A missing or read-only `/data` stopped the API from booting (`multer`). See `apps/api/src/http/archiveUpload.ts`.
- `settingsChangeRoutes` and `improvementEngine` stored JSON as a string in jsonb on real Postgres. **No repair migration was added**, so installs that already saved those settings may hold bad rows.
- `localSync` failed on macOS for pinned folders.
- The agent's "promise" re-prompt overrode the honest "I have not searched" reply. A model that says "let me search" right after that correction now keeps that reply.
- `resolveDataPath` honours `JOSI_TEST_DATA_DIR` only when `NODE_ENV=test`. That's a test hook in product code.

## Decisions still open

- "Astra" isn't a known OpenAI model. Its row in `heyjosi.models` is disabled with no model id, and Terra is disabled beside it.
- Prices came from press coverage, not OpenAI's own page.
- The $12 monthly AI allowance is a default I chose (`AI_INCLUDED_USD`).
