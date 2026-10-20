import AppKit
import SwiftUI
import Darwin

/// An explicitly selected export, private while incomplete and published only
/// after the complete stream is verified. No server-supplied path is used.
final class NativePrivateExport {
    private let directory: Int32
    private let descriptor: Int32
    private let temporary = ".josi-export-" + UUID().uuidString.lowercased()
    private let filename: String
    init(destination: URL) throws {
        filename = destination.lastPathComponent
        let parent = open(destination.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard parent >= 0 else { throw JosiError(message: "Choose an accessible folder for this export.") }
        let output = openat(parent, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard output >= 0 else {
            Darwin.close(parent)
            throw JosiError(message: "A private export file could not be created.")
        }
        directory = parent; descriptor = output
    }
    deinit { Darwin.close(descriptor); unlinkat(directory, temporary, 0); Darwin.close(directory) }
    func write(_ bytes: Data) throws {
        var offset = 0
        while offset < bytes.count {
            let count = bytes.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress!.advanced(by: offset), bytes.count - offset) }
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw JosiError(message: "The export could not be written. Check available storage.") }
            offset += count
        }
    }
    func finish() throws {
        guard fsync(descriptor) == 0, renameat(directory, temporary, directory, filename) == 0 else {
            throw JosiError(message: "The export could not be saved in the selected folder.")
        }
    }
}

struct NativeBackupsView: View {
    @EnvironmentObject var model: JosiModel
    @State private var view: Wire = .null
    @State private var note = ""
    @State private var creating = false
    @State private var downloading = false
    @State private var cancelDownload = false
    @State private var generation = 0
    @State private var refreshing = false
    @State private var masterKeySaved = false
    private var running: Bool { creating || view["backups"].list.contains { $0["state"].text == "running" } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    Text("Backups").font(.largeTitle.bold())
                    Spacer()
                    Button("Refresh") { model.run { try await load() } }.disabled(model.busy)
                }
                Text("A full backup is used for restoration. A portable export is for taking your data elsewhere and does not include recovery copies.")
                    .foregroundStyle(.secondary)
                GroupBox("Keep your recovery material separately") {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(view["masterKeyGuidance"].text.isEmpty
                             ? "The installation master key is not included in these archives. Keep it and your Vault recovery copy safe outside Josi."
                             : view["masterKeyGuidance"].text)
                        Toggle("I have saved the installation master key separately", isOn: $masterKeySaved)
                    }.padding(10)
                }
                HStack {
                    Button("Back Up Now") { create("full") }.buttonStyle(.borderedProminent)
                    Button("Portable Export") { create("portable") }
                }.disabled(model.busy || running || !model.isAdministrator || view == .null)
                if downloading {
                    HStack {
                        Text("Saving the archive to your selected folder…")
                        Button(cancelDownload ? "Cancelling…" : "Cancel Download") { cancelDownload = true }.disabled(cancelDownload)
                    }
                }
                if !note.isEmpty { Text(note).font(.callout).textSelection(.enabled) }
                if view == .null { Text("Backup history is unavailable. Refresh to load the current server state.") }
                else if view["backups"].list.isEmpty { Text("No backups have been recorded.") }
                ForEach(view["backups"].list, id: \.identifier) { backup in
                    GroupBox(backup["kind"].text == "full" ? "Full backup" : "Portable export") {
                        VStack(alignment: .leading, spacing: 10) {
                            Text(stateLabel(backup["state"].text)).font(.headline)
                            Text(nativeDate(backup["created_at"].text) + " · " + byteLabel(backup["byte_size"])).font(.caption).foregroundStyle(.secondary)
                            if backup["state"].text == "running" {
                                Text(backup["progress_phase"].text)
                                ProgressView(value: Double(max(0, min(100, backup["progress_percent"].integer))), total: 100)
                                Text("Step \(backup["progress_step"].integer) of \(backup["progress_steps"].integer)").font(.caption)
                            } else if backup["state"].text == "complete" {
                                Button("Save Archive…") { download(backup) }.disabled(model.busy)
                            } else if backup["state"].text == "failed" {
                                Text(backup["error_category"].text).font(.caption).foregroundStyle(.orange)
                            }
                        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }.padding(30).frame(maxWidth: 900).frame(maxWidth: .infinity)
        }
        .task {
            while !Task.isCancelled {
                if NSApp.isActive && (!model.busy || creating) {
                    do { try await load() }
                    catch { if !Task.isCancelled { model.error = error.localizedDescription } }
                }
                do { try await Task.sleep(for: .seconds(running ? 3 : 15)) } catch { return }
            }
        }
        .onDisappear { generation += 1; cancelDownload = true; view = .null }
    }
    private func load() async throws {
        guard model.isAdministrator, !refreshing, let api = model.api else { return }
        refreshing = true; defer { refreshing = false }
        let user = model.user["id"], started = generation
        do {
            let result = try await api.request("/ops/admin/backups")
            guard !Task.isCancelled, generation == started, model.api === api, model.user["id"] == user else { return }
            view = result
        } catch {
            guard !Task.isCancelled, generation == started, model.api === api else { return }
            view = .null; throw error
        }
    }
    private func create(_ kind: String) {
        guard !running, !model.busy, let api = model.api, model.isAdministrator else { return }
        let user = model.user["id"], confirmation = masterKeySaved
        generation += 1; creating = true; note = ""
        model.run {
            defer { creating = false }
            do {
                let result = try await api.request("/ops/admin/backups", method: "POST",
                    body: ["kind": .string(kind), "masterKeyConfirmed": .bool(confirmation)])
                guard model.api === api, model.user["id"] == user else { return }
                note = result["description"].text
                try await load()
            } catch {
                try? await load()
                throw JosiError(message: "The backup request was not confirmed. Inspect its current history before trying again; work on the server may still be running.")
            }
        }
    }
    private func download(_ backup: Wire) {
        guard model.isAdministrator, let api = model.api, let size = byteCount(backup["byte_size"]),
              size > 0, backup["state"].text == "complete", let id = try? api.uuid(backup.identifier) else { return }
        let user = model.user["id"]
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "Josi-\(backup["kind"].text == "full" ? "backup" : "export")-\(id).zip"
        guard panel.runModal() == .OK, let destination = panel.url, !model.busy else { return }
        downloading = true; cancelDownload = false; note = ""
        model.run {
            defer { downloading = false; model.activity = "" }
            do {
                try await api.downloadBackup(id, expectedBytes: size, destination: destination) { count in
                    guard !cancelDownload, model.api === api, model.user["id"] == user, model.isAdministrator else { throw CancellationError() }
                    model.activity = "Saving backup: \(ByteCountFormatter.string(fromByteCount: count, countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: size, countStyle: .file))"
                }
                note = "Archive saved. Keep the installation master key separately; an archive alone is not a complete recovery."
            } catch is CancellationError {
                note = "Download cancelled. The selected destination was not replaced."
            }
        }
    }
    private func byteCount(_ value: Wire) -> Int64? {
        if case .string(let text) = value { return Int64(text) }
        if case .number(let number) = value, number.isFinite, number >= 0, number <= 9_007_199_254_740_991, number.rounded() == number { return Int64(number) }
        return nil
    }
    private func byteLabel(_ value: Wire) -> String {
        byteCount(value).map { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) } ?? "Size unavailable"
    }
    private func stateLabel(_ value: String) -> String {
        switch value { case "running": return "Still being written"; case "complete": return "Ready to save"; case "failed": return "Did not finish"; default: return "Status unavailable" }
    }
}
