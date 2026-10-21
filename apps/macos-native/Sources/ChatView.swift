import AppKit
import SwiftUI

struct ChatView: View {
    @EnvironmentObject var model: JosiModel
    @StateObject private var voice = NativeVoice()
    @State private var voiceSettings = false
    @State private var modelName = ""
    private var title: String { model.threads.first { $0.identifier == model.selectedThread }?["title"].text.nonempty ?? "Conversation" }
    private var thinking: Bool { model.turns.contains { ["queued", "running"].contains($0["status"].text) } }
    private var canSend: Bool { !model.busy && (model.pendingMessage || !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 5) { Text(title).font(.title3.weight(.semibold)); Text("Conversation").font(.caption).foregroundStyle(JosiTheme.muted) }
                Spacer()
                if !modelName.isEmpty { Text(modelName).font(.caption).foregroundStyle(JosiTheme.muted) }
            }.padding(.horizontal, 28).padding(.top, 28).padding(.bottom, 18)
            Divider().padding(.horizontal, 24)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 28) {
                        if model.messages.isEmpty {
                            VStack(spacing: 16) {
                                JosiMark(size: 64)
                                Text("What would you like to get done?").font(.title2.weight(.semibold))
                                Text("Ask Josi, attach a photo, or start a voice conversation.").foregroundStyle(JosiTheme.muted)
                            }.frame(maxWidth: .infinity).padding(.top, 70).padding(.bottom, 30)
                        }
                        ForEach(model.messages, id: \.identifier) { message in
                            messageRow(message).id(message.identifier)
                            ForEach(model.turns.filter { $0["status"].text == "failed" && $0["inbound_message_id"].text == message.identifier }, id: \.identifier) { ChatTurnFailure(turn: $0) }
                        }
                        ForEach(model.chatGoals, id: \.identifier) { GoalCard(goal: $0, compact: true) }
                        ForEach(model.turns.filter { turn in turn["status"].text == "failed" && !model.messages.contains { $0.identifier == turn["inbound_message_id"].text } }, id: \.identifier) { ChatTurnFailure(turn: $0) }
                        if thinking { JosiThinking() }
                        Color.clear.frame(height: 1).id("latest")
                    }.padding(28).frame(maxWidth: 900).frame(maxWidth: .infinity)
                }
                .onChange(of: model.messages.last?.identifier) { _, _ in withAnimation { proxy.scrollTo("latest", anchor: .bottom) } }
                .onChange(of: thinking) { _, active in if active { withAnimation { proxy.scrollTo("latest", anchor: .bottom) } } }
            }
            composer.padding(.horizontal, 24).padding(.top, 8).padding(.bottom, 12).frame(maxWidth: 930)
            Text(model.pendingMessage ? "Delivery is unconfirmed. Retry keeps the same message and attachments." : "Enter to send · Shift + Enter for a new line")
                .font(.caption).foregroundStyle(JosiTheme.muted).padding(.bottom, 16)
        }
        .sheet(isPresented: $voiceSettings) { NativeVoiceSettings(voice: voice).environmentObject(model).preferredColorScheme(.dark) }
        .task {
            guard let api = model.api else { return }
            await voice.refresh(api, administrator: model.isAdministrator)
            if model.isAdministrator, let primary = try? await api.request("/admin/llm") {
                let value = primary["primary"]
                modelName = value["provider"].text == "openai_subscription" ? "ChatGPT plan" : value["model"].text
            }
        }
        .onChange(of: model.selectedThread) { _, _ in voice.stop() }
        .onDisappear { voice.stop() }
    }
    @ViewBuilder private func messageRow(_ message: Wire) -> some View {
        if message["direction"].text == "in" {
            HStack {
                Spacer(minLength: 70)
                VStack(alignment: .trailing, spacing: 7) {
                    VStack(alignment: .leading, spacing: 8) {
                        attachments(message)
                        Text(message["body"].text).textSelection(.enabled).lineSpacing(4)
                    }.padding(.horizontal, 18).padding(.vertical, 14)
                        .background(JosiTheme.raised, in: RoundedRectangle(cornerRadius: 20))
                    Text("You").font(.caption).foregroundStyle(JosiTheme.muted)
                }.frame(maxWidth: 640, alignment: .trailing)
            }
        } else {
            HStack(alignment: .top, spacing: 15) {
                JosiMark(size: 34)
                VStack(alignment: .leading, spacing: 12) {
                    Text("Josi").font(.callout.weight(.semibold))
                    Text(.init(message["body"].text)).textSelection(.enabled).lineSpacing(5).frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 18) {
                        Button { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(message["body"].text, forType: .string) } label: { Image(systemName: "doc.on.doc") }
                            .help("Copy message").accessibilityLabel("Copy message")
                        Button {
                            if voice.speaking { voice.interrupt() }
                            else if let api = model.api { Task { do { try await voice.speak(message["body"].text, api: api) } catch { voice.error = error.localizedDescription } } }
                        } label: { Image(systemName: voice.speaking ? "stop.circle" : "speaker.wave.2") }
                            .help("Read aloud").accessibilityLabel("Read aloud").disabled(!voice.available)
                    }.buttonStyle(.plain).foregroundStyle(JosiTheme.muted).padding(.top, 2)
                }
            }
        }
    }
    private func attachments(_ message: Wire) -> some View {
        ForEach(message["attachments"].list, id: \.identifier) { item in Label(item["filename"].text, systemImage: "paperclip").font(.caption).foregroundStyle(JosiTheme.muted) }
    }
    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !model.draftAttachments.isEmpty {
                ScrollView(.horizontal) { HStack {
                    ForEach(model.draftAttachments, id: \.identifier) { item in
                        HStack { Image(systemName: "paperclip"); Text(item["filename"].text).lineLimit(1)
                            Button { model.draftAttachments.removeAll { $0.identifier == item.identifier } } label: { Image(systemName: "xmark.circle.fill") }
                                .buttonStyle(.plain).help("Remove attachment from message")
                        }.font(.caption).padding(8).background(JosiTheme.card, in: Capsule())
                    }
                } }
            }
            ZStack(alignment: .topLeading) {
                if model.draft.isEmpty { Text("Message Josi…").foregroundStyle(JosiTheme.muted).padding(.top, 9).padding(.leading, 8).allowsHitTesting(false) }
                JosiMessageEditor(text: $model.draft, enabled: !model.pendingMessage && voice.mode != .conversation, onSend: send)
                    .frame(height: min(140, max(68, CGFloat(model.draft.filter { $0 == "\n" }.count + 1) * 21 + 30)))
            }
            if !voice.partial.isEmpty { Text(voice.partial).font(.callout).foregroundStyle(JosiTheme.muted).lineLimit(3) }
            if !voice.error.isEmpty { Text(voice.error).font(.caption).foregroundStyle(JosiTheme.orange).textSelection(.enabled) }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) { composerLeft; Spacer(minLength: 0); composerRight }
                VStack(alignment: .leading, spacing: 10) { composerLeft; HStack { Spacer(); composerRight } }
            }
        }.padding(16).background(JosiTheme.raised.opacity(0.75), in: RoundedRectangle(cornerRadius: 23))
            .overlay(RoundedRectangle(cornerRadius: 23).stroke(JosiTheme.muted.opacity(0.35), lineWidth: 1))
    }
    private var composerLeft: some View {
        HStack(spacing: 8) {
            Button(action: attach) { Image(systemName: "plus").font(.title3).frame(width: 18) }
                .buttonStyle(JosiPillStyle()).help("Attach a file or photo").accessibilityLabel("Attach a file or photo")
                .disabled(model.busy || model.pendingMessage || model.draftAttachments.count >= 10 || voice.mode != nil)
            Button { voiceSettings = true } label: { HStack(spacing: 7) { Text(voice.modelLabel); Image(systemName: "chevron.down").font(.caption) } }
                .buttonStyle(JosiPillStyle()).help("Voice models and settings").disabled(voice.mode != nil)
        }
    }
    private var composerRight: some View {
        HStack(spacing: 8) {
            Button { toggleVoice(.dictation) } label: { Label(voice.mode == .dictation ? "Done" : "Dictate", systemImage: voice.mode == .dictation ? "stop.fill" : "mic") }
                .buttonStyle(JosiPillStyle()).disabled(model.pendingMessage || voice.starting || voice.mode == .conversation)
            if voice.mode == .conversation {
                Button { voice.stop() } label: { Label("End voice", systemImage: "stop.fill") }.buttonStyle(JosiPillStyle(prominent: true))
            } else if canSend {
                Button(action: send) { Image(systemName: "arrow.up").font(.headline).frame(width: 18) }
                    .buttonStyle(JosiPillStyle(prominent: true)).help(model.pendingMessage ? "Retry delivery" : "Send message")
                    .accessibilityLabel(model.pendingMessage ? "Retry delivery" : "Send message")
            } else {
                Button { toggleVoice(.conversation) } label: { Label("Voice chat", systemImage: "waveform") }
                    .buttonStyle(JosiPillStyle(prominent: true)).disabled(voice.starting || model.busy || voice.mode != nil || !model.draftAttachments.isEmpty)
            }
        }
    }
    private func send() {
        guard canSend else { return }
        voice.stop(); model.run { try await model.send() }
    }
    private func attach() {
        let panel = NSOpenPanel(); panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        panel.message = "Choose a file or photo to attach to this conversation."
        guard panel.runModal() == .OK, let url = panel.url else { return }
        model.run { try await model.attach(url) }
    }
    private func toggleVoice(_ mode: NativeVoice.Mode) {
        if voice.mode != nil {
            if voice.mode == .dictation, !voice.partial.isEmpty { model.draft += (model.draft.isEmpty ? "" : " ") + voice.partial }
            voice.stop(); return
        }
        guard voice.available else { voiceSettings = true; return }
        guard let api = model.api else { return }
        Task {
            await voice.start(mode, api: api) { text in
                if mode == .dictation {
                    model.draft += (model.draft.isEmpty || model.draft.hasSuffix(" ") || model.draft.hasSuffix("\n") ? "" : " ") + text
                    return nil
                }
                return try await model.voiceTurn(text)
            }
        }
    }
}
private extension String { var nonempty: String? { isEmpty ? nil : self } }
