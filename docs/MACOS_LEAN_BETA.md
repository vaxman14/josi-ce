# Josi for Mac: the lean beta

`apps/macos-native/Josi.xcodeproj` builds one app, **Josi** (`JOSI_SERVER_APP`): the server with the client built in. "Run on this Mac", Server Controls, the menu bar item, Model and Network & address.

A standalone client is a later project. The `JOSI_SERVER_APP` checks stay in the sources for it, but nothing builds it.

Open the project in Xcode and run. Debug builds are signed to run locally. To point a Debug run of Josi at a development server, set `JOSI_LOCAL_SERVER` in the scheme's environment.

## Flags

`apps/macos-native/Sources/JosiFlags.swift` holds every switch. The relay, heyjosi.com addresses, the hosted account service, paid plans and included AI are off unless `RELAY_ENABLED` is added to a target's Active Compilation Conditions. Hidden sections stay in the source; turn one back on there.

## Mascot and type

The ghost's clips are transparent HEVC in `Resources/Mascot` (`idle-wiggle`, `listening`, `thinking`, `gentle-float`), played by the Masko player package. A missing clip falls back to the gold J. `JosiMark` in `JosiTheme.swift` is the one place the J is drawn. Fonts and their licenses are in `Resources/Fonts`.

## Sign-in

Google and passkeys run on the server's own page in the system sign-in sheet, because a self-hosted address can't be an app's associated domain. Passkeys need `APP_URL` to be HTTPS on a name, or localhost. Sign in with Apple needs the app signed with an Apple-provisioned profile that has that capability, and `APPLE_NATIVE_CLIENT_ID` set on the server to the app's bundle ID.
