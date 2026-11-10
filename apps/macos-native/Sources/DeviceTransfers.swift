import AppKit
import SwiftUI

/// Send to my devices (docs/LINUX_CATCHUP_HANDOFF.md, item 3): a file from one
/// Josi app to another on the same server. Between a person's own devices it
/// arrives with no question, into ~/Downloads/Josi, marked as downloaded. From
/// another person it waits for this person to accept it.
@MainActor final class DeviceTransfers: ObservableObject {
    static let shared = DeviceTransfers()
    @Published private(set) var offers: [Wire] = []
    @Published private(set) var received: [(name: String, url: URL)] = []
    private var registeredFor: String?
    private var running = false
    private var busy: Set<String> = []
    private var device: String { PcDevice.id }

    func start(_ model: JosiModel) {
        guard !running else { return }
        running = true
        Task { @MainActor in
            while true {
                try? await Task.sleep(for: .seconds(8))
                guard let api = model.api, model.screen == .workspace else { registeredFor = nil; offers = []; continue }
                let key = api.origin.absoluteString + "|" + model.user["id"].text
                if registeredFor != key {
                    do {
                        _ = try await api.request("/device-transfers/devices/\(device)", method: "PUT",
                                                  body: ["name": .string(PcDevice.name), "platform": "macos"])
                        registeredFor = key
                    } catch { continue }  // An older server has no transfers.
                }
                await check(api)
            }
        }
    }
    private func check(_ api: JosiAPI) async {
        guard let inbox = try? await api.request("/device-transfers/inbox?deviceId=\(device)") else { return }
        let waiting = inbox["transfers"].list
        let newOffers = waiting.filter { $0["state"].text == "offered" }
        if Set(newOffers.map(\.identifier)) != Set(offers.map(\.identifier)) {
            if newOffers.contains(where: { offer in !offers.contains { $0.identifier == offer.identifier } }) { NSApp.requestUserAttention(.informationalRequest) }
            offers = newOffers
        }
        for transfer in waiting where transfer["state"].text == "accepted" && !busy.contains(transfer.identifier) {
            busy.insert(transfer.identifier)
            defer { busy.remove(transfer.identifier) }
            guard let data = try? await api.transferContent(transfer.identifier, device: device), let saved = save(data, name: transfer["name"].text) else { continue }
            _ = try? await api.request("/device-transfers/\(try api.uuid(transfer.identifier))/received", method: "POST", body: ["deviceId": .string(device)])
            received.insert((transfer["name"].text, saved), at: 0)
            if received.count > 5 { received.removeLast() }
            NSApp.requestUserAttention(.informationalRequest)
        }
    }
    /// ~/Downloads/Josi/<name>, never over an existing file, marked as downloaded
    /// so macOS checks it like anything else from the internet.
    private func save(_ data: Data, name: String) -> URL? {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0].appendingPathComponent("Josi", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let safe = name.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        let base = (safe as NSString).deletingPathExtension, ext = (safe as NSString).pathExtension
        for n in 0..<1000 {
            let candidate = folder.appendingPathComponent(n == 0 ? safe : "\(base) (\(n))" + (ext.isEmpty ? "" : ".\(ext)"))
            if FileManager.default.fileExists(atPath: candidate.path) { continue }
            guard FileManager.default.createFile(atPath: candidate.path, contents: data, attributes: [.posixPermissions: 0o644]) else { return nil }
            var url = candidate
            var values = URLResourceValues()
            values.quarantineProperties = [kLSQuarantineAgentNameKey as String: "Josi", kLSQuarantineTypeKey as String: kLSQuarantineTypeWebDownload as String]
            try? url.setResourceValues(values)
            return candidate
        }
        return nil
    }
    func answer(_ offer: Wire, accept: Bool, api: JosiAPI) {
        offers.removeAll { $0.identifier == offer.identifier }
        Task { _ = try? await api.request("/device-transfers/\(try api.uuid(offer.identifier))/\(accept ? "accept" : "decline")", method: "POST", body: ["deviceId": .string(device)]) }
    }
    func dismissReceived() { received = [] }
}

/// Offers from other people and files that just arrived, above the chat bar.
struct TransferCards: View {
    @EnvironmentObject var model: JosiModel
    @ObservedObject private var transfers = DeviceTransfers.shared
    var body: some View {
        if !transfers.offers.isEmpty || !transfers.received.isEmpty {
            VStack(spacing: 8) {
                ForEach(transfers.offers, id: \.identifier) { offer in
                    HStack {
                        Text("\(offer["from"].text) wants to send you \(offer["name"].text) (\(ByteCountFormatter.string(fromByteCount: Int64(offer["size"].integer), countStyle: .file)))")
                            .font(JosiFont.callout).lineLimit(2)
                        Spacer()
                        Button("Accept") { if let api = model.api { transfers.answer(offer, accept: true, api: api) } }.buttonStyle(JosiGoldButtonStyle(fullWidth: false))
                        Button("Decline") { if let api = model.api { transfers.answer(offer, accept: false, api: api) } }.buttonStyle(JosiOutlineButtonStyle())
                    }
                }
                ForEach(Array(transfers.received.enumerated()), id: \.offset) { _, item in
                    HStack {
                        Text("Received \(item.name), in Downloads › Josi").font(JosiFont.callout).lineLimit(1)
                        Spacer()
                        Button("Show in Finder") { NSWorkspace.shared.activateFileViewerSelecting([item.url]) }.buttonStyle(JosiOutlineButtonStyle())
                        Button { transfers.dismissReceived() } label: { Image(systemName: "xmark") }.buttonStyle(.plain).foregroundStyle(JosiTheme.muted)
                    }
                }
            }
            .padding(12).background(JosiTheme.card, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(JosiTheme.hairline, lineWidth: 1))
            .padding(.horizontal, 26).frame(maxWidth: 830)
        }
    }
}

/// "Send to a device or person…": one of my other devices, or someone on this Josi.
struct SendToDevicesSheet: View {
    @EnvironmentObject var model: JosiModel
    @Environment(\.dismiss) private var dismiss
    @State private var list: Wire = .null
    @State private var target: String?
    @State private var file: URL?
    @State private var working = false
    @State private var problem = ""
    @State private var done = ""
    private var devices: [Wire] { list["devices"].list.filter { $0["id"].text != PcDevice.id } }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Send a file").font(JosiFont.title3)
            NativeLeanNote(text: "To one of your devices it arrives at once. Someone else is asked first. Up to 25 MB, kept on your server for a week at most.")
            if list == .null { ProgressView().controlSize(.small) }
            if !devices.isEmpty { Text("Your devices").font(JosiFont.caption).foregroundStyle(JosiTheme.muted) }
            ForEach(devices, id: \.self["id"].text) { device in row("device:" + device["id"].text, device["name"].text, device["platform"].text) }
            if !list["people"].list.isEmpty { Text("People on this Josi").font(JosiFont.caption).foregroundStyle(JosiTheme.muted) }
            ForEach(list["people"].list, id: \.identifier) { person in row("user:" + person.identifier, person["name"].text.isEmpty ? person["username"].text : person["name"].text, "") }
            if list != .null && devices.isEmpty && list["people"].list.isEmpty {
                NativeLeanNote(text: "No other device of yours is signed in to this Josi yet, and nobody else is here.")
            }
            HStack {
                Button(file == nil ? "Choose a File…" : file!.lastPathComponent) { choose() }.buttonStyle(JosiOutlineButtonStyle())
                Spacer()
            }
            if !problem.isEmpty { Text(problem).font(JosiFont.callout).foregroundStyle(JosiTheme.error) }
            if !done.isEmpty { Text(done).font(JosiFont.callout).foregroundStyle(JosiTheme.success) }
            HStack {
                Spacer()
                Button("Close") { dismiss() }.buttonStyle(JosiOutlineButtonStyle()).keyboardShortcut(.cancelAction)
                Button("Send", action: send).buttonStyle(JosiGoldButtonStyle(fullWidth: false)).disabled(target == nil || file == nil || working)
            }
        }
        .padding(24).frame(width: 480).background(JosiTheme.deep)
        .task {
            guard let api = model.api else { return }
            list = (try? await api.request("/device-transfers/devices?deviceId=\(PcDevice.id)")) ?? ["devices": .array([]), "people": .array([])]
        }
    }
    private func row(_ id: String, _ name: String, _ platform: String) -> some View {
        Button { target = id } label: {
            HStack {
                Image(systemName: target == id ? "largecircle.fill.circle" : "circle").foregroundStyle(target == id ? JosiTheme.gold : JosiTheme.muted)
                Text(name).font(JosiFont.callout)
                if !platform.isEmpty { Text(platform).font(JosiFont.caption).foregroundStyle(JosiTheme.muted) }
                Spacer()
            }.contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
    private func choose() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        if panel.runModal() == .OK { file = panel.url }
    }
    private func send() {
        guard let api = model.api, let target, let file else { return }
        working = true; problem = ""; done = ""
        let toDevice = target.hasPrefix("device:") ? String(target.dropFirst(7)) : nil
        let toUser = target.hasPrefix("user:") ? String(target.dropFirst(5)) : nil
        Task {
            defer { working = false }
            do {
                let result = try await api.sendTransfer(file, toDevice: toDevice, toUser: toUser, from: PcDevice.id)
                done = result["state"].text == "offered" ? "Sent. They'll be asked to accept it." : "Sent."
                self.file = nil
            } catch { problem = error.localizedDescription }
        }
    }
}
