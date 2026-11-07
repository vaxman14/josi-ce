import AppKit
import SwiftUI

/// The left half of the welcome and sign-in screens: the mark in its halo.
struct JosiStage: View {
    var title: String
    var subtitle: String
    @EnvironmentObject var model: JosiModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false
    var body: some View {
        VStack(spacing: 22) {
            ZStack {
                Circle().fill(RadialGradient(colors: [JosiTheme.gold.opacity(0.45), JosiTheme.gold.opacity(0)], center: .center, startRadius: 0, endRadius: 100))
                    .frame(width: 200, height: 200).scaleEffect(pulsing ? 1.15 : 1).opacity(pulsing ? 0.55 : 1)
                Circle().stroke(JosiTheme.gold.opacity(0.45), lineWidth: 1).frame(width: 152, height: 152)
                    .scaleEffect(pulsing ? 1.06 : 1).opacity(pulsing ? 0.4 : 1)
                JosiGhost(ghost: model.ghost, size: 200)
            }.frame(width: 180, height: 180)
                .animation(reduceMotion ? nil : .easeInOut(duration: 1.2).repeatForever(autoreverses: true), value: pulsing)
            Text(title).font(JosiFont.display(34)).multilineTextAlignment(.center)
            Text(subtitle).foregroundStyle(JosiTheme.lilac).multilineTextAlignment(.center).frame(maxWidth: 340)
        }.frame(maxWidth: .infinity).onAppear { pulsing = true }
    }
}

/// Stage on the left, panel on the right, both centred at the same height.
struct JosiSplit<Stage: View, Panel: View>: View {
    @ViewBuilder var stage: Stage
    @ViewBuilder var panel: Panel
    var body: some View {
        ScrollView {
            HStack(alignment: .center, spacing: 50) {
                stage
                panel.frame(maxWidth: .infinity)
            }.padding(.horizontal, 60).padding(.vertical, 40)
        }.defaultScrollAnchor(.center).scrollBounceBehavior(.basedOnSize)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct ConnectionView: View {
    @EnvironmentObject var model: JosiModel
    var body: some View {
        JosiSplit {
            JosiFlags.serverApp
                ? JosiStage(title: "Welcome to Josi", subtitle: "Your conversations, your work, your Mac.")
                : JosiStage(title: "Welcome to Josi Client", subtitle: "Connect to your Josi server and use the same account, conversations and work.")
        } panel: {
            VStack(spacing: 14) { if JosiFlags.serverApp { localCard } else { connectCard; getJosiCard } }.frame(maxWidth: 440)
        }.disabled(model.busy)
    }
    private var deviceLine: String {
        var parts = ["Version \(model.receipt.version)"]
        if let count = model.devicesConnected { parts.append("\(count) \(count == 1 ? "device" : "devices") connected") }
        return parts.joined(separator: " · ")
    }
    private var localCard: some View {
        JosiCard {
            HStack(spacing: 10) {
                Text("On this Mac").font(JosiFont.display(18))
                if model.receipt.installed { JosiPill(text: model.receipt.stopped ? "Stopped" : "Running", color: model.receipt.stopped ? JosiTheme.error : JosiTheme.success) }
            }
            Text(model.receipt.installed
                 ? "Server on this Mac. It keeps running when you close Josi, so your other devices can keep using it."
                 : "Set up a server here, or restore the data kept from your last install.")
                .font(JosiFont.callout).foregroundStyle(JosiTheme.lilac)
            if model.receipt.installed {
                HStack(spacing: 10) {
                    Circle().fill(model.receipt.stopped ? JosiTheme.error : JosiTheme.success).frame(width: 8, height: 8)
                    Text(deviceLine).font(JosiFont.callout)
                    Spacer()
                }.padding(.horizontal, 12).padding(.vertical, 10).background(JosiTheme.deep, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(JosiTheme.border, lineWidth: 1))
                Button("Run on this Mac  →") { model.run { try await model.connect(model.receipt.address, local: true) } }
                    .buttonStyle(JosiGoldButtonStyle()).keyboardShortcut(.defaultAction)
            } else {
                Button("Set Up on This Mac…") { model.run { try await model.operate("install") } }
                    .buttonStyle(JosiGoldButtonStyle()).disabled(!NativeServer.canManage)
                if !NativeServer.canManage { Text("Install the signed app in Applications to set up a server.").font(JosiFont.caption).foregroundStyle(JosiTheme.muted) }
            }
        }
    }
    private var connectCard: some View {
        JosiCard {
            Text("Connect to your server").font(JosiFont.display(18))
            Text("Your server keeps its accounts and data.").font(JosiFont.callout).foregroundStyle(JosiTheme.lilac)
            VStack(alignment: .leading, spacing: 5) {
                Text("Server address or domain").font(JosiFont.caption).foregroundStyle(JosiTheme.lilac)
                TextField("josi.example.com", text: $model.address).textFieldStyle(JosiFieldStyle()).onSubmit { connect() }
                Text("Remote connections use HTTPS. Localhost is supported for a server on this Mac.").font(JosiFont.caption).foregroundStyle(JosiTheme.muted)
            }
            Button("Connect") { connect() }.buttonStyle(JosiGoldButtonStyle()).keyboardShortcut(.defaultAction)
                .disabled(model.address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }
    private var getJosiCard: some View {
        JosiCard {
            Text("No server yet?").font(JosiFont.display(18))
            Text("Josi is a separate download that runs a server on a Mac.").font(JosiFont.callout).foregroundStyle(JosiTheme.lilac)
            Button("Get Josi") { if let url = URL(string: "https://github.com/vaxman14/josi-ce/releases/latest") { NSWorkspace.shared.open(url) } }
                .buttonStyle(JosiOutlineButtonStyle())
        }.opacity(0.8)
    }
    private func connect() { model.run { try await model.connect(model.address) } }
}

struct ServerControls: View {
    @EnvironmentObject var model: JosiModel
    var compact = false
    @State private var pendingOperation: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if !compact {
                JosiHeading(title: "Server on this Mac", subtitle: "Manage local hosting without leaving Josi.")
                Text(model.receipt.installed ? "\(model.receipt.address) · \(model.receipt.version)" : "Local server is not installed.")
            }
            if model.receipt.installed {
                HStack {
                    Button("Start") { operate("start") }
                    Button("Stop…") { pendingOperation = "stop" }
                    Button("Restart…") { pendingOperation = "restart" }
                }
                HStack {
                    Button("Update Server…") { pendingOperation = "install" }
                    Button("Repair…") { pendingOperation = "recover-latest" }
                }
            }
            Button("Refresh Status") { model.refreshLocal() }
            if !compact {
                Text("Updates use the existing recovery-copy and migration process. macOS will ask for administrator authorization.")
                    .foregroundStyle(JosiTheme.lilac)
                Button("Open Uninstaller…") {
                    let target = URL(fileURLWithPath: "/Applications/Uninstall Josi.app")
                    if FileManager.default.fileExists(atPath: target.path) { NSWorkspace.shared.openApplication(at: target, configuration: .init()) }
                    else { model.error = "Install the complete Josi package to add its uninstaller." }
                }
                if !NativeServer.canManage { Text("Install the signed app in Applications to enable server changes.").foregroundStyle(JosiTheme.lilac) }
            }
        }
        .buttonStyle(JosiOutlineButtonStyle())
        .disabled(model.busy || !NativeServer.canManage)
        .confirmationDialog("Apply this local server change?", isPresented: Binding(get: { pendingOperation != nil }, set: { if !$0 { pendingOperation = nil } })) {
            Button("Continue") { if let operation = pendingOperation { pendingOperation = nil; operate(operation) } }
            Button("Cancel", role: .cancel) { pendingOperation = nil }
        } message: {
            Text(pendingOperation == "stop" ? "Connected devices will lose access until you start the server again."
                 : "Josi will use the existing server installation. Keep the app open until the operation finishes.")
        }
    }
    private func operate(_ operation: String) { model.run { try await model.operate(operation) } }
}

struct ServerControlsSheet: View {
    @EnvironmentObject var model: JosiModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            ServerControls()
            HStack { Spacer(); Button("Done") { dismiss() }.buttonStyle(JosiGoldButtonStyle(fullWidth: false)).keyboardShortcut(.defaultAction) }
        }.padding(28).frame(width: 560).background(JosiBackdrop()).foregroundStyle(JosiTheme.text).tint(JosiTheme.gold)
            .font(JosiFont.body()).preferredColorScheme(.dark).groupBoxStyle(JosiGroupBoxStyle())
    }
}

/// The menu bar item, in the server app only.
struct ServerTrayMenu: View {
    @EnvironmentObject var model: JosiModel
    @Environment(\.openWindow) private var openWindow
    var body: some View {
        Text(!model.receipt.installed ? "No server on this Mac" : model.receipt.stopped ? "Server on this Mac stopped" : "Server on this Mac running")
        if let count = model.devicesConnected { Text("\(count) \(count == 1 ? "device" : "devices") connected") }
        Divider()
        Button("Open Josi") { open() }
        Button("Server Controls…") { open(); model.openServerControls() }
        Button("Restart…") { open(); model.openServerControls() }.disabled(!model.receipt.installed)
        Button("Stop…") { open(); model.openServerControls() }.disabled(!model.receipt.installed || model.receipt.stopped)
    }
    private func open() { NSApp.activate(ignoringOtherApps: true); openWindow(id: "josi") }
}

enum JosiTray {
    /// The J as a template image, so the menu bar tints it for light and dark.
    @MainActor static var icon: NSImage {
        let image = Bundle.main.url(forResource: "JosiMark", withExtension: "png").flatMap { NSImage(contentsOf: $0) } ?? NSImage()
        image.size = NSSize(width: 18, height: 18); image.isTemplate = true
        return image
    }
}
