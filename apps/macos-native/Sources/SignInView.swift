import AppKit
import SwiftUI

struct LoginView: View {
    @EnvironmentObject var model: JosiModel
    @State private var identifier = ""
    @State private var password = ""
    @State private var remember = true
    @State private var passwordSetup = false
    private var local: Bool { JosiFlags.serverApp }
    private var needsCode: Bool { !model.mfaChallenge.isEmpty }
    var body: some View {
        JosiSplit {
            needsCode ? JosiStage(title: "One more step", subtitle: "Enter your verification or recovery code.")
                : JosiStage(title: "Sign in to Josi", subtitle: local ? "Sign in to the server on this Mac." : "Sign in on your server.")
        } panel: {
            Group { if needsCode { TwoFactorPanel() } else { panel } }.frame(maxWidth: 400)
        }.disabled(model.busy)
            .sheet(isPresented: $passwordSetup) { NativePasswordSetupView().environmentObject(model) }
    }
    private var panel: some View {
        JosiCard {
            Text("Sign in to Josi").font(JosiFont.title)
            Text("Your assistant, on your own server.").font(JosiFont.callout).foregroundStyle(JosiTheme.lilac)
            status
            if model.appleLink.isEmpty {
                Button { model.run { try await model.signInWithPasskey(remember: remember) } } label: {
                    Label("Sign in with passkey", systemImage: "lock")
                }.buttonStyle(JosiGoldButtonStyle())
                JosiDivider(text: "or")
                HStack(spacing: 8) {
                    Button { model.run { try await model.signInWithApple(remember: remember) } } label: { Label("Apple", systemImage: "apple.logo") }
                    Button { model.run { try await model.signInWithGoogle(remember: remember) } } label: {
                        HStack(spacing: 6) { Text("G").fontWeight(.bold).foregroundStyle(Color(hex: 0x4285F4)); Text("Google") }
                    }
                }.buttonStyle(JosiProviderButtonStyle())
                JosiDivider(text: "or use your password")
            } else {
                Text("Enter your password once to link Apple to your account.").font(JosiFont.callout).foregroundStyle(JosiTheme.lilac)
            }
            field("Username or email") { TextField("", text: $identifier).textContentType(.username).textFieldStyle(JosiFieldStyle()) }
            field("Password") { SecureField("", text: $password).textContentType(.password).textFieldStyle(JosiFieldStyle()).onSubmit { submit() } }
            Toggle("Keep me signed in on this device", isOn: $remember).toggleStyle(.checkbox).font(JosiFont.callout).foregroundStyle(JosiTheme.lilac)
            Button(model.appleLink.isEmpty ? "Sign In" : "Link and Sign In") { submit() }
                .buttonStyle(JosiOutlineButtonStyle(fullWidth: true)).keyboardShortcut(.defaultAction)
            Button("Invitation or password reset…") { password = ""; passwordSetup = true }
                .buttonStyle(.plain).font(JosiFont.body(13, weight: .medium)).foregroundStyle(JosiTheme.gold).frame(maxWidth: .infinity)
        }
    }
    private var status: some View {
        HStack(spacing: 8) {
            Circle().fill(JosiTheme.success).frame(width: 8, height: 8)
            Text(local ? "Local server · this Mac" : "Connected to \(model.address)").lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 4)
            if !local {
                Button("Change") { password = ""; model.disconnect() }.buttonStyle(.plain).foregroundStyle(JosiTheme.gold)
            }
        }.font(JosiFont.caption).foregroundStyle(JosiTheme.lilac).padding(.horizontal, 10).padding(.vertical, 8)
            .background(JosiTheme.deep, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(JosiTheme.border, lineWidth: 1))
    }
    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 5) { Text(label).font(JosiFont.caption).foregroundStyle(JosiTheme.lilac); content() }
    }
    private func submit() {
        let value = password; password = ""
        if model.appleLink.isEmpty { model.run { try await model.signIn(identifier: identifier, password: value, remember: remember) } }
        else { model.run { try await model.completeApple(identifier: identifier, password: value, code: "") } }
    }
}

struct JosiDivider: View {
    var text: String
    var body: some View {
        HStack(spacing: 10) {
            Rectangle().fill(JosiTheme.border).frame(height: 1)
            Text(text).font(JosiFont.caption).foregroundStyle(JosiTheme.muted).fixedSize()
            Rectangle().fill(JosiTheme.border).frame(height: 1)
        }
    }
}

struct JosiProviderButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(JosiFont.body(13, weight: .semibold)).padding(.vertical, 8).frame(maxWidth: .infinity)
            .foregroundStyle(Color.black).background(Color.white, in: RoundedRectangle(cornerRadius: 10))
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}

/// Six boxes over one real field. The single field keeps the one-time-code
/// content type, so password managers fill it, and paste works.
struct TwoFactorPanel: View {
    @EnvironmentObject var model: JosiModel
    @State private var code = ""
    @State private var recovery = false
    @FocusState private var focused: Bool
    var body: some View {
        JosiCard {
            Text("Verification code").font(JosiFont.title)
            Text(recovery ? "Enter one of your recovery codes." : "Enter the 6-digit code from your authenticator app. Josi submits it as soon as the last digit is in.")
                .font(JosiFont.callout).foregroundStyle(JosiTheme.lilac)
            if recovery {
                SecureField("Recovery code", text: $code).textFieldStyle(JosiFieldStyle()).onSubmit { submit() }
                Button("Verify") { submit() }.buttonStyle(JosiGoldButtonStyle()).keyboardShortcut(.defaultAction)
            } else {
                ZStack {
                    TextField("", text: $code).textContentType(.oneTimeCode).textFieldStyle(.plain).focused($focused)
                        .opacity(0.02).accessibilityLabel("Verification code")
                        .onChange(of: code) { _, value in
                            let digits = String(value.filter(\.isNumber).prefix(6))
                            if digits != value { code = digits }
                            if digits.count == 6 { submit() }
                        }
                    HStack(spacing: 8) {
                        ForEach(0..<6, id: \.self) { index in
                            let digits = Array(code)
                            Text(index < digits.count ? String(digits[index]) : " ").font(JosiFont.body(20, weight: .semibold))
                                .frame(width: 46, height: 52).background(JosiTheme.deep, in: RoundedRectangle(cornerRadius: 11))
                                .overlay(RoundedRectangle(cornerRadius: 11).stroke(index == digits.count && focused ? JosiTheme.gold : JosiTheme.border, lineWidth: 1))
                        }
                    }.allowsHitTesting(false).accessibilityHidden(true)
                }.contentShape(Rectangle()).onTapGesture { focused = true }
            }
            HStack {
                Button("Back") { code = ""; model.mfaChallenge = ""; model.appleMfa = false }
                Spacer()
                Button(recovery ? "Use authenticator code" : "Use a recovery code") { code = ""; recovery.toggle() }
            }.buttonStyle(.plain).font(JosiFont.body(13, weight: .medium)).foregroundStyle(JosiTheme.gold)
        }.onAppear { focused = true }
    }
    private func submit() {
        let value = code; code = ""
        guard !value.isEmpty else { return }
        model.run { try await model.verifyMFA(value) }
    }
}
