import AppKit
import SwiftUI

struct NativeNetworkView: View {
    @EnvironmentObject var model: JosiModel
    @State private var network: Wire = .null
    @State private var address = ""
    @State private var loaded = false
    @State private var unavailable = false
    @State private var error = ""
    @State private var note = ""
    @State private var generation = 0
    private var tailscale: Wire { network["tailscale"] }
    private var tailscaleSet: Bool {
        network["mode"].text == "tailscale" && network["publicUrl"] == network["tailscaleUrl"]
    }

    var body: some View {
        NativeLeanPage {
            HStack(alignment: .top) {
                JosiHeading(title: "Network", subtitle: "Where this server answers, and how your other devices reach it.")
                Button("Refresh") { model.run { await load() } }.buttonStyle(JosiOutlineButtonStyle()).disabled(model.busy)
            }
            NativeLeanStatus(loading: !loaded && error.isEmpty && !unavailable, error: error, note: note)
            if unavailable {
                NativeLeanNote(text: "This server does not offer network settings yet. Update the server to use them.")
            } else if network != .null {
                addressCard
                changeCard
                tailscaleCard
            }
        }
        .textFieldStyle(JosiFieldStyle())
        .task { await load() }
        .onDisappear { generation += 1 }
    }

    private var addressCard: some View {
        JosiCard {
            NativeLeanTitle(text: "Current address")
            Text(network["publicUrl"].text).font(JosiFont.body(15, weight: .medium)).textSelection(.enabled)
            NativeLeanNote(text: modeText(network["mode"].text))
            if network["restartNeeded"].flag {
                NativeLeanNote(text: "The saved address (\(network["configuredUrl"].text)) differs from the running one. Restart the server to apply it.", color: JosiTheme.gold)
            }
            if !network["lan"].list.isEmpty {
                Text("This Mac on your network").font(JosiFont.headline)
                ForEach(Array(network["lan"].list.enumerated()), id: \.offset) { _, item in
                    HStack {
                        Text(item["name"].text + ": " + lanURL(item)).font(JosiFont.callout).textSelection(.enabled)
                        Spacer()
                        Button("Use This") { address = lanURL(item) }.buttonStyle(JosiOutlineButtonStyle())
                    }
                }
                NativeLeanNote(text: "Other devices reach this server at one of these once it is set as the address below.", color: JosiTheme.muted)
            }
            if !network["certificate"]["fingerprint"].text.isEmpty {
                NativeLeanNote(text: "Certificate fingerprint: " + network["certificate"]["fingerprint"].text, color: JosiTheme.muted)
            }
        }
    }
    private var changeCard: some View {
        JosiCard {
            NativeLeanTitle(text: "Direct address")
            NativeLeanNote(text: "Enter this Mac's network IP, its hostname, or your own domain, with the port. Beyond this Mac the address must use HTTPS. On your network Josi issues its own certificate; a public domain needs your own reverse proxy pointed at this Mac.")
            if network["editable"].flag {
                TextField("Address and port, starting with https://", text: $address)
                Button("Save Address…") { save(address) }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                    .disabled(model.busy || address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            } else {
                NativeLeanNote(text: "This server takes its address from where it is started, so set APP_URL there.")
            }
        }
    }
    private var tailscaleCard: some View {
        JosiCard {
            NativeLeanTitle(text: "Tailscale")
            NativeLeanNote(text: "Reach Josi from anywhere with no public domain and no port forwarding. Install Tailscale here and on each device, and sign them in to the same account.")
            if !tailscale["installed"].flag {
                NativeLeanNote(text: "Tailscale is not installed on this Mac. Install it, sign in, then refresh this page.")
                Button("Get Tailscale") {
                    if let url = URL(string: "https://tailscale.com/download") { NSWorkspace.shared.open(url) }
                }.buttonStyle(JosiOutlineButtonStyle())
            } else if !tailscale["running"].flag {
                NativeLeanNote(text: tailscale["error"].text.isEmpty ? "Tailscale is installed but not connected. Open it, sign in, then refresh this page." : tailscale["error"].text)
            } else {
                NativeLeanNote(text: "Connected as " + (tailscale["loginName"].text.isEmpty ? "your account" : tailscale["loginName"].text)
                               + (tailscale["tailnet"].text.isEmpty ? "." : " on " + tailscale["tailnet"].text + "."))
                Text(network["tailscaleUrl"].text).font(JosiFont.body(15, weight: .medium)).textSelection(.enabled)
                if !tailscale["ips"].list.isEmpty {
                    NativeLeanNote(text: "Tailscale IP: " + tailscale["ips"].list.map(\.text).joined(separator: ", "), color: JosiTheme.muted)
                }
                if tailscaleSet {
                    NativeLeanNote(text: "This is the address now. On each device, sign in to Tailscale and give the Josi app this address.")
                } else if network["editable"].flag {
                    Button("Use the Tailscale Address…") { save(network["tailscaleUrl"].text) }
                        .buttonStyle(JosiGoldButtonStyle(fullWidth: false)).disabled(model.busy || network["tailscaleUrl"].text.isEmpty)
                }
            }
        }
    }

    private func lanURL(_ item: Wire) -> String { "https://\(item["address"].text):\(network["port"].integer)" }
    private func modeText(_ mode: String) -> String {
        ["local": "Only this Mac reaches Josi.",
         "lan": "This Mac and your network, over HTTPS with Josi's own certificate.",
         "tailscale": "Your devices over Tailscale, over HTTPS with Josi's own certificate.",
         "public": "A public domain, served through your own reverse proxy."][mode] ?? ""
    }
    /// The server's reply is written for another platform, so the result is
    /// described here from the mode it reports.
    private func savedText(_ mode: String) -> String {
        ["local": "Saved. Only this Mac will reach Josi. Restart the server to apply it.",
         "lan": "Saved. Josi will answer on your network over HTTPS. Restart the server to apply it.",
         "tailscale": "Saved. Josi will answer at its Tailscale address over HTTPS. Restart the server to apply it.",
         "public": "Saved. Point your reverse proxy at this Mac, then restart the server to apply it."][mode] ?? "Saved. Restart the server to apply it."
    }
    private func load() async {
        guard model.isAdministrator, let api = model.api else { return }
        let owner = model.user["id"], started = generation
        func current() -> Bool { !Task.isCancelled && generation == started && model.api === api && model.user["id"] == owner }
        do {
            let result = try await api.request("/admin/network")
            guard current() else { return }
            network = result; loaded = true; unavailable = false; error = ""
        } catch {
            guard current() else { return }
            if nativeRouteMissing(error) { unavailable = true } else { self.error = error.localizedDescription }
        }
    }
    private func save(_ value: String) {
        let target = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let api = model.api, model.isAdministrator, !target.isEmpty,
              nativeConfirm("Change the server address to \(target)?",
                            detail: "It takes effect when the server restarts. Devices using the old address will need the new one.",
                            button: "Save Address") else { return }
        let owner = model.user["id"]
        error = ""; note = ""
        model.run {
            do {
                let result = try await api.request("/admin/network", method: "PUT", body: ["publicUrl": .string(target)])
                guard model.api === api, model.user["id"] == owner else { return }
                note = savedText(result["mode"].text); address = ""
                await load()
            } catch {
                guard model.api === api else { return }
                self.error = error.localizedDescription
            }
        }
    }
}
