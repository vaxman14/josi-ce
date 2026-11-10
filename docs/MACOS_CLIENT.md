# Josi Client for Mac (November 10, 2026)

The Mac twin of the Windows client (`docs/WINDOWS_CLIENT_NODE_SPEC.md`, the
owner's five decisions). Josi Client is the Josi app without the server. It
connects to a Josi server somewhere else, does everything the signed-in person
may do there, and is a node: that server can work on this Mac.

## Build

    python3 scripts/macos/build-client.py --version X.Y.Z --notarize-profile josi-notary --node ~/JosiBuild/runtime-lean/node/bin/node

Same Swift sources as Josi, compiled with `JOSI_CLIENT_APP` (no
`JOSI_SERVER_APP`), as `/Applications/Josi Client.app`, bundle id
`com.heyjosi.ce.client`, about 30 MB. It carries its own browser helpers,
Safari extension (`com.heyjosi.ce.client.workspace-safari`) and login item
(`com.heyjosi.ce.client.browser`): `JosiEdition` in
`apps/automation-macos/Sources/GuestBrowserIPC.swift` tells each helper which
Josi it sits in, so the two editions never answer for each other. The installer
is `Josi-Client-X.Y.Z-macOS-arm64.pkg`; updates look for that name.

## The five decisions, on the Mac

1. **Reach.** An `https://` address, a bare host or a LAN address
   (`192.168.1.20:8443` means https). A LAN server with its own certificate is
   trusted after the person confirms its fingerprint once; its authority
   (`/api/network/ca`) is pinned in `~/Library/Application Support/Josi/trusted`.
   Plain http stays loopback only. Pairing through heyjosi.com stays off
   (`RELAY_ENABLED`).
2. **Approving the node.** Right after an interactive sign-in, if this Mac is
   not approved for that server and account, macOS shows its administrator
   prompt (Authorization Services) and the Mac enrols with `{elevated: true}`.
   Declined, or a sign-in older than ten minutes: "Approve This Mac" stays, with
   the password as the fallback. Unlike Windows (HKLM), the approval is not
   recorded anywhere only an administrator can write; the server cannot verify
   it either way.
3. **Who controls which computer.** The person signed in on it, following
   `pcControlAllowed`; the owner too controls only the owner's own computers.
4. **Window closed.** Josi Client stays in the menu bar (its own menu: where it
   is connected, Pause or Resume, Quit) and opens at login, in the menu bar
   only. Both are settings under Settings › Josi on this Mac, on by default.
   Hidden, it retries the last server every 30 s.
5. **Sections.** Everything the person may use. Server, Network & address and
   Model need the server's own Mac and stay with Josi.

## Also in both editions (the November 9 list)

Send to my devices (`/api/device-transfers`, platform `macos`, files from my own
devices into `~/Downloads/Josi`, marked as downloaded), the account connection
card (link-free return, polling `/connections/:provider/native/complete`),
focus back to the message bar after a reply, and the wording that connected
accounts start on.

## Checked

Built, signed, notarized and stapled. A debug copy of the client connected to a
private test server, signed in, registered as a `macos` device and received a
file sent from a second device into Downloads › Josi, which the server then
marked delivered. Not yet run on another Mac against a real server: the
administrator prompt, the LAN certificate trust, Safari in the client, and
opening at login.
