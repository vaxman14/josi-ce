# Relay protocol

How devices and a Josi server talk through the relay, or directly on the LAN.
This is the reference the TypeScript, Swift and C# clients are written from. The
TypeScript in `packages/tunnel/src` is the source of truth; its test vectors are
in `packages/tunnel/test/vectors`.

## Keys

- **Server static key:** X25519. Private half in the OS key store (`docs/RELAY_PRIVACY.md`).
- **Device static key:** X25519, one per device, made on the device, never sent anywhere.
- A device learns the server's public key from the pairing code or QR. After that
  it keeps the key and refuses anything else, so the relay can't step in between.

## Noise

`Noise_IK_25519_ChaChaPoly_SHA256`, revision 34. The device is the initiator.
Prologue: the 12 bytes `josi-relay/1`.

Each handshake message and each transport message is one binary WebSocket
message. Message 1 carries a JSON **hello**, message 2 a JSON **welcome**.

    { "v":1, "op":"connect", "client":"web|mac|windows|ios|android|cli", "ts":<ms> }
    { "v":1, "op":"pair", "code":"<32 chars>", "name":"Pixel 9", "platform":"android", "ts":<ms> }

    { "ok":true, "device":"<uuid>", "server":"<server name>", "lan":["ws://192.168.1.5:18777/__josi/noise"],
      "rotate":{ "publicKey":"<base64url>", "until":"<ISO time or null>" } }      // rotate only when relevant
    { "ok":false, "error":"unknown_device|revoked|bad_code|busy|stale" }

`ts` must be within five minutes of the server's clock (`stale` otherwise). A
refused device gets the `ok:false` welcome and the connection closes.

**Sessions:** a request with `Authorization: Bearer …` passes through unchanged,
cookies included. Any other request uses a cookie jar the server keeps for that
device: the device's `Cookie` header is dropped, `Set-Cookie` never comes back,
and the jar's CSRF token is added to the request. So a client without a bearer
session needs no cookie or CSRF handling of its own over the tunnel.

## Transport

Every transport message is framed before encryption:

    byte 0      flags. Bit 0 set: sender rekeys after this message
    bytes 1-2   payload length, big endian
    payload
    zeros       up to a multiple of 256 bytes, capped at 65519

Max payload 65516. Empty associated data. The sender rekeys after 2^20 messages
or 3600 seconds, using the Noise `REKEY` function, and marks its last message
under the old key. Any message that fails to decrypt ends the session.

## Mux

Inside each payload: one byte type, four bytes big-endian stream id, then data.
Clients pick stream ids from 1 upward.

| Type | Name | Direction | Data |
|---|---|---|---|
| 1 | ReqHead | device → server | JSON `{method, path, headers:[[k,v]...]}` |
| 2 | ReqBody | device → server | bytes |
| 3 | ReqEnd | device → server | none. Always sent, even with no body |
| 4 | ResHead | server → device | JSON `{status, headers:[[k,v]...]}` |
| 5 | ResBody | server → device | bytes |
| 6 | ResEnd | server → device | none |
| 7 | Reset | either | none. Cancels the stream |
| 8 | Ping | either | stream 0 |
| 9 | Pong | either | stream 0 |
| 10 | Control | either | stream 0, JSON (below) |

Control messages:

    device → server  { "t":"rotate-device", "publicKey":"<base64url>" }
    server → device  { "t":"rotate-device-ok" } | { "t":"rotate-device-refused", "error":"…" }
    server → device  { "t":"rotate-server", "publicKey":"<base64url>", "until":"<ISO or null>" }
    server → device  { "t":"revoked" }

On `rotate-server` (or `rotate` in a welcome), save the new key and use it next
time. On `revoked`, delete the pairing.

## Reaching the server

Try in this order:

1. Each `lan` address from the last welcome, with a short timeout (800 ms). Plain
   `ws://` is fine: Noise authenticates and encrypts it. Same handshake, same keys.
2. The relay: `wss://<relay>/v1/sites/<site>/peer`, or by name
   `wss://<name>.heyjosi.com/__josi/connect`.

While on the relay, retry the LAN addresses about once a minute and move new
requests over when one answers.

Relay text messages (`{"type":"server-online"}`, `{"type":"server-offline"}`)
aren't authenticated. Treat them as hints only: wait for `server-online` before
sending message 1, and give up on `server-offline`.

## Pairing

1. The server makes a 160-bit code: 32 Crockford base32 characters, shown in
   groups of four, valid 10 minutes, single use.
2. **QR:** `https://<name>.heyjosi.com/#josi-pair=<code>.<base64url(JSON box)>`.
   The box is in the link, so no lookup is needed.
3. **Typed:** normalize (uppercase, drop spaces and dashes, O→0, I/L→1), then
   `GET /v1/invites/<id>` where `id` is the first 32 hex characters of
   `SHA-256("josi-invite-id/1|" + code)`. Open the returned `box` (base64url of
   12-byte nonce + ChaCha20-Poly1305 ciphertext) with key
   `SHA-256("josi-invite-key/1|" + code)`.
4. Box: `{ "v":1, "server":"<base64url>", "site":"<32 hex>", "relay":"wss://…", "name":"alice", "lan":[…] }`.
5. Make a device key, connect, send the `pair` hello. Keep `device` from the welcome.

Pairing only opens the transport. Every person still signs in to Josi as usual.

## Relay frames

Between the relay and the server only, binary: 16-byte peer id + Noise message.
Peer ids are random per connection. Text: `{"type":"peer-open","peer":"<32 hex>"}`,
`{"type":"peer-close","peer":…}`, and from the server `{"type":"kick","peer":…}`.
