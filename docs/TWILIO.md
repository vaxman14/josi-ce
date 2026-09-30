# Twilio SMS and local voice

Twilio is an optional, operator-owned Josi CE channel. Each installation uses
its own Twilio account, Messaging Service and SMS/voice-capable number. Josi CE
does not proxy traffic through a publisher account and does not provide A2P
registration.

## Requirements

- A paid Twilio account with an SMS/voice-capable number.
- A Messaging Service containing that number. US 10DLC traffic needs an
  approved A2P campaign whose declared use case covers the messages sent.
- A public HTTPS Josi URL. Calling additionally requires WebSocket support at
  the same origin; Caddy and Cloudflare Tunnel support this configuration.
- A healthy optional Voice Box for calling. Voice stays local after Twilio
  delivers the telephone audio: Silero detects speech, faster-whisper
  transcribes it and Kokoro synthesizes Josi's response.

## Administrator setup

1. Open **Admin → Messaging channels → Twilio SMS + calling**.
2. Enter the Account SID, Auth Token, Messaging Service SID and number in E.164
   form. Josi encrypts the credential and never returns it to the browser.
3. Choose **Test**. The test proves the account, owned number, SMS and voice
   capabilities, Messaging Service and number membership.
4. Turn the channel on.
5. Choose **Register webhooks**. Josi configures the number's SMS and voice URLs
   and tells the Messaging Service to defer inbound messages to that number.
6. Install and verify Voice Box under **Admin → Voice Box** before testing a
   call.

The registered endpoints are:

- `POST /channels/twilio/webhook` — inbound SMS/MMS metadata
- `POST /channels/twilio/status` — outbound delivery status
- `POST /channels/twilio/voice` — inbound/outbound call instructions
- `WSS /channels/twilio/voice/stream` — bidirectional telephone audio
- `POST /channels/twilio/call-status` — call lifecycle status

Every HTTP request and WebSocket upgrade is validated with Twilio's request
signature against the installation's exact public URL. Provider message IDs
are idempotency keys. Credentials are sealed with the installation master key.

## Linking and calling

Twilio does not make a caller ID an account credential. A signed-in person
creates a single-use code under **Channels → Twilio**, then texts `link CODE`
to the configured number. The code expires after ten minutes and its plaintext
is never stored.

After linking:

- SMS reaches the same Josi account, conversation, memory, model, tools,
  approvals and audit trail as web chat.
- Calling the Twilio number starts local speech only for that linked identity.
- **Call me** places an outbound call only to the linked number. Arbitrary
  third-party calling is intentionally absent; it requires a separate
  approval-gated action and anti-abuse policy.

Twilio continues handling carrier-level STOP/START/HELP behavior. Josi returns
an empty synchronous TwiML response for SMS and runs the model asynchronously,
then sends the answer through the Messaging API.

## Capacity and audio

Twilio Media Streams uses 8 kHz mu-law telephone audio. Josi converts incoming
audio to 16 kHz PCM for Voice Box and converts Kokoro's 24 kHz PCM back to
8 kHz mu-law. Replies are sent in bounded chunks; new speech clears buffered
playback for barge-in.

The low-resource profile is Whisper Tiny English plus Kokoro and one live call
at a time. Whisper Base improves recognition on a faster CPU. The LLM remains
the selected Josi provider and can still dominate response latency.

## Disconnecting

Turn Twilio off before changing credentials or public domains. Disabling the
channel rejects new webhooks immediately but preserves conversations. Revoke
individual phone links from **Channels**. Removing credentials or releasing a
number is performed in Twilio and is not implied by disabling Josi's channel.
