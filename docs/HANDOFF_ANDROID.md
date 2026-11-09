# Handoff: build the Josi CE Android app

You're finishing the native Android app so it connects through the new encrypted relay and offers the nine skins. You have no earlier context, so this page is everything you need.

## Rules from the owner
- Plain words. Say when it's ready or what stopped it, with the exact error.
- Never type, read or store passwords, tokens or secrets. `keystore.properties` and `firebase.properties` stay out of the repo.
- No pull requests and no merges. Ask before pushing.
- No Play Store upload. Don't touch the live Play app, and don't deploy anything.

## Get the code
- **App:** `vaxman14/josi-app`, branch `feat/android-compose`, folder `android-native`. Kotlin and Jetpack Compose, no web view. Start a new branch from it.
- **Protocol and reference code:** `vaxman14/josi-ce`, branch `hosted/relay-accounts-20261105`. If that branch isn't on GitHub, stop and tell the owner.

Read `android-native/AUTOMATION.md` first. From `josi-ce`, read `docs/RELAY_PROTOCOL.md`, `docs/RELAY_PRIVACY.md`, `packages/tunnel/src/{noise,mux,pairing,protocol,client}.ts` and `packages/tunnel/test/vectors`. The TypeScript is the source of truth. `apps/macos-native/Sources/Tunnel*.swift` and `apps/windows-native/src/Tunnel*.cs` are finished ports to copy the structure from.

## Build
Needs JDK 17 and an Android SDK with compile SDK 37. Min SDK is 26.
```bash
cd android-native && ./gradlew :app:testDebugUnitTest :app:assembleDebug
```
Debug builds use the id `com.socalreceptionist.josice.compose`, so they install beside the Play app. Without `firebase.properties` the app builds with push off.

## Job 1: the encrypted connection
Today the app talks to a server over plain HTTPS through OkHttp in `data/Ce.kt`. Add a Kotlin tunnel client, so a paired server is only ever reached through it. A paired server must never fall back to plain HTTPS.

- **Protocol:** `Noise_IK_25519_ChaChaPoly_SHA256`, prologue `josi-relay/1`, 256-byte padded framing with rekey, and the mux. All of it is in `docs/RELAY_PROTOCOL.md`.
- **Crypto:** the platform isn't enough at min SDK 26. It has no X25519 there, and no ChaCha20-Poly1305 before API 28. Use BouncyCastle's lightweight API, and reject low-order X25519 results.
- **Hooking in:** an OkHttp application interceptor that answers from the tunnel, so `Ce.kt` barely changes. It has to stream, because of `/assistant/...` progress.
- **Reaching the server:** try the `lan` addresses for 800 ms, then the relay. Plain `ws://` on the LAN is fine, since Noise protects it, but the manifest's cleartext rules need to allow it. Retry the LAN about once a minute.
- **Relay text frames** aren't authenticated. Treat them as hints only.
- **Device key:** one per install, made on the device. Android Keystore can't hold X25519 at API 26, so store it encrypted with a Keystore AES key, the way `data/Store.kt` stores secrets.
- **Pairing:** add a screen that takes a code, a pairing link or a QR code. Handle `rotate-server`, `revoked` and device key rotation.
- **Sessions:** keep `x-josi-client: native` and the bearer token. Bearer requests pass through the tunnel unchanged.

Tests must cover both JSON vectors, tamper refusal and code normalization, and at least one run against the real TypeScript host. `apps/windows-native/test/tunnel-console/interop/harness.ts` shows how to build that harness.

**Known traps:**
- `GET /api/auth/native/config` returns the server's own `appUrl`, and the app expects it to equal the origin. Through the tunnel the origin is `https://<name>.heyjosi.com`, so that check will fail on a server whose `APP_URL` is something else. Trust the pinned Noise key for a paired server, and skip that check.
- Connecting Google on Hey Josi ends on a web page at the user's address, not back in the app. Refresh `/connections` when the app resumes instead of waiting for a deep link.
- Typed codes need the live relay, which isn't deployed, so test with a link. Local relay:
```bash
cd services/relay && npm install && npx wrangler dev -c wrangler.dev.toml --port 8799 --ip 127.0.0.1
```

**Server needs one commit that isn't in the redesign branch.** `5fd5c81` on `feat/turn-activity-for-native` gives the app `activity` and approval `taskId` values. Without it, source cards stay empty. It merges cleanly, but merging is the owner's call. Ask.

## Job 2: the nine skins
The app has one look today: Josi Warm, in `ui/theme/Theme.kt` and `ui/FrostedNavBar.kt`. Add all nine, chosen by the user. The iPhone app is getting the same nine, so keep ids, names and colours identical. Add the notched bar for the four notched skins.

- Make a `Skin` type, and read every colour from the current skin. Nothing hard-coded in a screen.
- Add a Skins screen under More, showing a preview of each. Save the id, and fall back to `warm` if it's unknown.
- `ThemeContrastTest.kt` exists. Extend it to all nine skins, and fix what fails rather than loosening it.
- Keep the `josi.*` test ids. ClipForge depends on them.

The owner's iPhone design is below, exactly as written. It's the only copy that leaves the owner's Mac. Colours are `0xRRGGBB`.

### Skins

```swift
struct Skin: Identifiable {
    var id: String, name: String, note: String
    var scheme: ColorScheme? = nil
    var notched = true
    var scene: [Color]
    var surface: Color, variant: Color, text: Color, sub: Color, sceneSub: Color
    var primary: Color, onPrimary: Color, outline: Color, error: Color
    var bar: Color = .clear, barLow: Color = .clear, edge: Color = .clear, icon: Color = .clear
    var button: [Color] = [], ring: Color = .clear, shadow: Color = .clear, glow: Color = .clear
    var frost: Color? = nil

    static func hex(_ value: UInt32) -> Color { Color(light: value, dark: value) }
    static let all: [Skin] = base + base.dropFirst().map(\.frosted)
    private static let base: [Skin] = [
        Skin(id: "warm", name: "Josi Warm", note: "The Android rebuild, frosted bar", notched: false,
             scene: [Color(light: 0xD9C4A8, dark: 0x1F1610), Color(light: 0xD9C4A8, dark: 0x1F1610)],
             surface: Color(light: 0xF4EFE7, dark: 0x33261B), variant: Color(light: 0xECE3D6, dark: 0x3E2F22),
             text: Color(light: 0x2E2016, dark: 0xF4EFE7), sub: Color(light: 0x5B4632, dark: 0xC9B8A3), sceneSub: Color(light: 0x5B4632, dark: 0xC9B8A3),
             primary: Color(light: 0x5C7442, dark: 0xA9C98A), onPrimary: Color(light: 0xF4EFE7, dark: 0x2E2016),
             outline: hex(0x9A7552), error: Color(light: 0x8E2A1C, dark: 0xFFB4A1)),
        Skin(id: "mocha", name: "Josi CE Mocha Cloud", note: "Light", scheme: .light,
             scene: [hex(0xF3E6DE), hex(0xEBD9CF), hex(0xC9A390)],
             surface: hex(0xF9F2EC), variant: hex(0xF5EBE3), text: hex(0x7C5442), sub: hex(0x7A665B), sceneSub: hex(0x7C5442),
             primary: hex(0x7C5442), onPrimary: hex(0xF7F3EE), outline: hex(0xA47864), error: hex(0x8E2A1C),
             bar: hex(0xF2F0EB), barLow: hex(0xE7E2DA), edge: hex(0xA47864).opacity(0.35), icon: hex(0x7A665B),
             button: [hex(0xB48A74), hex(0x7C5442)], ring: hex(0xEBD9CF), shadow: hex(0x6E4632).opacity(0.28), glow: hex(0xB48A74).opacity(0.42)),
        Skin(id: "midnight", name: "Midnight Apricot", note: "Dark", scheme: .dark,
             scene: [hex(0x2B3154), hex(0x0E1120)],
             surface: hex(0x252B49), variant: hex(0x1C2140), text: hex(0xEE7A4C), sub: hex(0x8E97B8), sceneSub: hex(0x8E97B8),
             primary: hex(0xEE7A4C), onPrimary: hex(0x2A1608), outline: hex(0x8E97B8), error: hex(0xFFB4A1),
             bar: hex(0x1E2540), barLow: hex(0x131829), edge: Color.white.opacity(0.10), icon: hex(0x8E97B8),
             button: [hex(0xFFB27A), hex(0xEE7A4C)], ring: hex(0x0E1120), shadow: Color.black.opacity(0.5), glow: hex(0xFFB27A).opacity(0.42)),
        Skin(id: "plum", name: "Plum & Gold", note: "Dark", scheme: .dark,
             scene: [hex(0x43264A), hex(0x150B19)],
             surface: hex(0x3A2140), variant: hex(0x2A1730), text: hex(0xC49536), sub: hex(0xB9A0BD), sceneSub: hex(0xB9A0BD),
             primary: hex(0xC49536), onPrimary: hex(0x2C1A33), outline: hex(0xB9A0BD), error: hex(0xFFB4A1),
             bar: hex(0x2C1A33), barLow: hex(0x1B0F20), edge: hex(0xE9C46A).opacity(0.18), icon: hex(0xB9A0BD),
             button: [hex(0xF0CF7A), hex(0xC49536)], ring: hex(0x150B19), shadow: Color.black.opacity(0.55), glow: hex(0xF0CF7A).opacity(0.38)),
        Skin(id: "arctic", name: "Arctic Blue", note: "Light", scheme: .light,
             scene: [hex(0xE4ECF5), hex(0xC7D6E8)],
             surface: hex(0xF4F7FB), variant: hex(0xE9EFF7), text: hex(0x2F5FE0), sub: hex(0x586A82), sceneSub: hex(0x586A82),
             primary: hex(0x2F5FE0), onPrimary: hex(0xFFFFFF), outline: hex(0x6E87AA), error: hex(0x8E2A1C),
             bar: hex(0xFFFFFF), barLow: hex(0xF0F4F9), edge: hex(0x6E87AA).opacity(0.25), icon: hex(0x6B7C93),
             button: [hex(0x5B97FF), hex(0x2F5FE0)], ring: hex(0xE4ECF5), shadow: hex(0x284678).opacity(0.22), glow: hex(0x5B97FF).opacity(0.42)),
    ]
    /** The Josi Warm design (frosted bar with labels) in this skin's palette. */
    var frosted: Skin {
        var skin = self
        skin.id = id + "-frosted"
        skin.name = name.replacingOccurrences(of: "Josi CE ", with: "") + " Frosted"
        skin.note = "\(note), frosted bar"
        skin.notched = false
        skin.frost = bar.opacity(scheme == .dark ? 0.55 : 0.34)
        return skin
    }
    static var current: Skin {
        let id = UserDefaults.standard.string(forKey: "skin")
        return all.first { $0.id == id } ?? all[0]
    }
}
```

### NotchShape

```swift
struct NotchShape: Shape {
    var center: CGFloat
    var animatableData: CGFloat {
        get { center }
        set { center = newValue }
    }
    func path(in rect: CGRect) -> Path {
        let r: CGFloat = 22, w = rect.width, h = rect.height, x = center
        var p = Path()
        p.move(to: CGPoint(x: 0, y: r))
        p.addArc(center: CGPoint(x: r, y: r), radius: r, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        p.addLine(to: CGPoint(x: x - 40, y: 0))
        p.addCurve(to: CGPoint(x: x, y: 30), control1: CGPoint(x: x - 29.5, y: 0), control2: CGPoint(x: x - 26.5, y: 30))
        p.addCurve(to: CGPoint(x: x + 40, y: 0), control1: CGPoint(x: x + 26.5, y: 30), control2: CGPoint(x: x + 29.5, y: 0))
        p.addLine(to: CGPoint(x: w - r, y: 0))
        p.addArc(center: CGPoint(x: w - r, y: r), radius: r, startAngle: .degrees(270), endAngle: .degrees(0), clockwise: false)
        p.addLine(to: CGPoint(x: w, y: h - r))
        p.addArc(center: CGPoint(x: w - r, y: h - r), radius: r, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        p.addLine(to: CGPoint(x: r, y: h))
        p.addArc(center: CGPoint(x: r, y: h - r), radius: r, startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
        p.closeSubpath()
        return p
    }
}
```

### NotchedBar

```swift
struct NotchedBar: View {
    @Binding var selected: Tab
    var body: some View {
        let skin = Skin.current
        GeometryReader { box in
            // The first and last centers keep the notch clear of the bar's rounded corners.
            let inset: CGFloat = 62
            let step = (box.size.width - inset * 2) / CGFloat(Tab.allCases.count - 1)
            let index = CGFloat(Tab.allCases.firstIndex(of: selected) ?? 0)
            let center = inset + step * index
            ZStack(alignment: .topLeading) {
                NotchShape(center: center)
                    .fill(LinearGradient(colors: [skin.bar, skin.barLow], startPoint: .top, endPoint: .bottom))
                    .overlay { NotchShape(center: center).stroke(skin.edge, lineWidth: 1) }
                    .shadow(color: skin.shadow, radius: 10, y: 10)
                ForEach(Array(Tab.allCases.enumerated()), id: \.element) { offset, tab in
                    let x = inset + step * CGFloat(offset)
                    Button { select(tab) } label: {
                        Image(systemName: tab.symbol).font(.system(size: 22, weight: .regular)).foregroundStyle(skin.icon)
                            .opacity(tab == selected ? 0 : 1).frame(width: 56, height: 56).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityLabel(tab.rawValue).position(x: x, y: 33)
                }
                Circle().fill(skin.button.last ?? .clear).frame(width: 4, height: 4).position(x: center, y: 50)
                ZStack {
                    Circle().fill(skin.ring).frame(width: 60, height: 60)
                    Circle().fill(LinearGradient(colors: skin.button, startPoint: .top, endPoint: .bottom)).frame(width: 52, height: 52)
                    Image(systemName: selected.symbol).font(.system(size: 23, weight: .regular)).foregroundStyle(skin.onPrimary)
                        .id(selected).transition(.scale(scale: 0.6).combined(with: .opacity))
                }
                .shadow(color: skin.shadow, radius: 9, y: 9)
                .shadow(color: skin.glow, radius: 13)
                .position(x: center, y: 0)
                .accessibilityLabel("\(selected.rawValue), selected")
            }
        }
        .frame(height: 66)
        .padding(.horizontal, 16).padding(.bottom, -10)
    }
    private func select(_ tab: Tab) {
        withAnimation(.spring(response: 0.46, dampingFraction: 0.72)) { selected = tab }
    }
}
```

### FrostedBar

```swift
struct FrostedBar: View {
    @Binding var selected: Tab
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 26, style: .continuous)
        let dark = scheme == .dark
        GeometryReader { box in
            let width = box.size.width / CGFloat(Tab.allCases.count)
            let index = CGFloat(Tab.allCases.firstIndex(of: selected) ?? 0)
            ZStack(alignment: .bottomLeading) {
                HStack(spacing: 0) {
                    ForEach(Tab.allCases) { tab in
                        Button { withAnimation(.spring(response: 0.42, dampingFraction: 0.6)) { selected = tab } } label: {
                            VStack(spacing: 2) {
                                Image(systemName: tab.symbol).symbolVariant(tab == selected ? .fill : .none).font(.system(size: 21))
                                    .frame(height: 26)
                                Text(tab.rawValue).font(.system(size: 11, weight: tab == selected ? .bold : .medium)).padding(.bottom, 6)
                            }
                            .foregroundStyle(J.onBackground).frame(maxWidth: .infinity, maxHeight: .infinity).contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                }
                Circle().fill(J.onBackground).frame(width: 5, height: 5)
                    .offset(x: width * index + width / 2 - 2.5, y: -7)
            }
        }
        .frame(height: 70)
        .background {
            shape.fill(.ultraThinMaterial)
            shape.fill(Skin.current.frost ?? (dark ? Color(red: 0.2, green: 0.149, blue: 0.106).opacity(0.60) : Color(red: 1, green: 0.957, blue: 0.902).opacity(0.26)))
        }
        .clipShape(shape)
        .overlay { shape.strokeBorder(Color.white.opacity(dark ? 0.18 : 0.55), lineWidth: 1) }
        .overlay {
            shape.strokeBorder(LinearGradient(stops: [.init(color: .white.opacity(dark ? 0.34 : 0.9), location: 0), .init(color: .clear, location: 0.16)],
                                              startPoint: .top, endPoint: .bottom), lineWidth: 1)
        }
        .shadow(color: Skin.current.frost == nil ? (dark ? .black.opacity(0.45) : Color(red: 0.27, green: 0.18, blue: 0.08).opacity(0.28)) : Skin.current.shadow, radius: 11, y: 8)
        .padding(.horizontal, 14).padding(.bottom, 10)
    }
}
```

## When you finish
Report: the APK path and SHA-256, the tests you ran and their results, screenshots of all nine skins on a phone or emulator, a pairing through a local relay, and what you couldn't test. Commit to your branch only if the owner says so.
