# What the relay can and can't see

The relay is a Cloudflare Worker run by SOCAL RECEPTIONIST LLC. It connects your
devices to your Josi server when they aren't on the same network. This page says
exactly what that means, including the limits.

## It can't read or change your traffic

Your devices and your server encrypt everything end to end with
`Noise_IK_25519_ChaChaPoly_SHA256`. The relay passes sealed messages along and
holds no key that opens them. If it changes a byte, the connection ends. It can't
pretend to be your server, because each device already knows your server's key
from pairing.

This covers phones, desktop apps and browsers. The relay never handles a page,
a request or a reply from your server as readable content.

## What it can see

- Your address, such as `alice.heyjosi.com`
- Whether your server is online
- When devices connect and disconnect, and their internet addresses
- Roughly how much data moves, to the nearest 256 bytes per message

The relay gives each connection a random id. It doesn't know which device is
which, though timing and addresses could be used to guess.

## The limits, plainly

**Browsers trust a starter page.** A browser has to get its first page from
somewhere, and at your address that's the relay. That page is small and the same
for everyone, and everything after it comes from your server. But a dishonest
relay operator could swap it for one that steals what you type. The Mac and
Windows apps don't have this limit, because their code doesn't come from the
relay. The source is in `services/relay/loader` and `packages/tunnel/src`, and
`node services/relay/build-assets.mjs` rebuilds it, so you can compare hashes
with what's served. A hash check only tells you about the copy you fetched.

**We run the name.** We control `heyjosi.com`, so we could point your address
somewhere else. Apps would refuse, since the other end wouldn't hold your
server's key. A browser that's already paired would too. A browser pairing for
the first time relies on the starter page, as above.

**Cloudflare runs the relay's computers.** It sees the same things the relay
does, and it handles the starter page.

**Hey Josi AI isn't end to end.** On Connect + AI, your requests pass through our
gateway on their way to OpenAI. The gateway has to read them to forward them. It
stores token counts and cost, and never the text. OpenAI's terms apply to what it
receives. With your own AI key, none of this touches us.

**Google tokens pass through us briefly.** Google requires the app's secret to
issue and refresh tokens, and that secret can't live on every server. So heyjosi.com
handles your tokens in memory when you connect and each time one is refreshed,
about once an hour while in use. It stores none of them. They're stored only in
your server's Vault. With your own Google client, none of this touches us.

## What your account can and can't do

A Hey Josi account holds your email, a password hash, 2FA data, your plan, your
AI usage, your server's public key, and the names of your devices. It can't open
your server, sign in to it, add a device to it, or read anything on it. It can
remove a device, and a plan that ends pauses your address.

So someone who breaks into your account, or into ours, can knock a device off and
take your address offline. They can't get in.

## Keys

- Each device has its own key, made on the device. Removing one cuts it off at
  once, and it can't come back without a new pairing and a new key.
- Your server's private key is in macOS Keychain, Windows Credential Manager or
  the Linux Secret Service. On a machine with none of these, such as a Docker
  install, it's in a private file (mode 0600), and the Hey Josi page says so.
- Pairing codes hold 160 random bits, work once, and last 10 minutes.

## Not using it

Free Josi CE doesn't need the relay and contacts none of this. You can also
[run your own relay](SELF_HOSTED_RELAY.md), or use your own domain or Tailscale.
On your own network, devices connect straight to your server and skip the relay.
