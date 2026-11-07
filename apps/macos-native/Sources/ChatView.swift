import AppKit
import SwiftUI

struct ChatView: View {
    @EnvironmentObject var model: JosiModel
    @StateObject private var voice = NativeVoice()
    @State private var voiceSettings = false
    @State private var modelName = ""
    @State private var floating = false
    @State private var settle: Task<Void, Never>?
    private var firstName: String { model.signedInName.split(separator: " ").first.map(String.init) ?? "" }
    private var thinking: Bool { (model.pendingMessage && model.busy) || model.turns.contains { ["queued", "running"].contains($0["status"].text) } }
    private var canSend: Bool { !model.busy && (model.pendingMessage || !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
    /// Thinking wins while the model works. The float follows a reply for a few
    /// seconds, then the ghost rests, unless someone is typing or the mic is on.
    private var mood: GhostMood {
        if thinking { return .thinking }
        if floating { return .float }
        if voice.mode != nil || !model.draft.isEmpty { return .listening }
        return .idle
    }
    private static let suggestions = ["What’s on my calendar today?", "Remind me to call Dana", "Draft a note to the team"]
    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        if model.messages.isEmpty, !thinking { greeting }
                        ForEach(model.messages, id: \.identifier) { message in
                            messageRow(message).id(message.identifier)
                            ForEach(model.turns.filter { $0["status"].text == "failed" && $0["inbound_message_id"].text == message.identifier }, id: \.identifier) { ChatTurnFailure(turn: $0) }
                        }
                        ForEach(model.chatGoals, id: \.identifier) { GoalCard(goal: $0, compact: true) }
                        ForEach(model.turns.filter { turn in turn["status"].text == "failed" && !model.messages.contains { $0.identifier == turn["inbound_message_id"].text } }, id: \.identifier) { ChatTurnFailure(turn: $0) }
                        if thinking || floating { ghostRow }
                        Color.clear.frame(height: 1).id("latest")
                    }.padding(.horizontal, 30).padding(.vertical, 24).frame(maxWidth: 900).frame(maxWidth: .infinity)
                }
                .onChange(of: model.messages.last?.identifier) { _, _ in withAnimation { proxy.scrollTo("latest", anchor: .bottom) } }
                .onChange(of: thinking) { _, active in if active { withAnimation { proxy.scrollTo("latest", anchor: .bottom) } } }
            }
            composer.padding(.horizontal, 26).padding(.top, 8).padding(.bottom, 8).frame(maxWidth: 930)
            Text(footer).font(JosiFont.caption).foregroundStyle(JosiTheme.muted).padding(.bottom, 14)
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
        .onChange(of: model.selectedThread) { _, _ in voice.stop(); settle?.cancel(); floating = false }
#if DEBUG
        .onChange(of: mood) { _, next in JosiDriver.log("mood \(next.rawValue)") }
#endif
        .onChange(of: thinking) { _, active in
            settle?.cancel()
            if active { floating = true; return }
            guard model.messages.last?["direction"].text != "in" else { floating = false; return }
            settle = Task { try? await Task.sleep(for: .seconds(4)); if !Task.isCancelled { floating = false } }
        }
        .onDisappear { voice.stop(); settle?.cancel() }
    }
    private var footer: String {
        if model.pendingMessage { return "Delivery is unconfirmed. Retry keeps the same message and attachments." }
        return "Enter to send · Shift + Enter for a new line" + (modelName.isEmpty ? "" : " · " + modelName)
    }
    private var greeting: some View {
        VStack(spacing: 6) {
            JosiGhost(mood: mood, size: 220)
            Text(firstName.isEmpty ? "Hi, I’m Josi." : "Hi \(firstName), I’m Josi.").font(JosiFont.display(24)).padding(.top, 14)
            Text("Ask me anything. I’m right here.").foregroundStyle(JosiTheme.lilac)
            HStack(spacing: 8) {
                ForEach(Self.suggestions, id: \.self) { text in
                    Button(text) { model.draft = text; send() }.buttonStyle(JosiChipStyle()).disabled(model.busy)
                }
            }.padding(.top, 12)
        }.frame(maxWidth: .infinity).padding(.top, 40).padding(.bottom, 20)
    }
    private var ghostRow: some View {
        HStack(spacing: 10) {
            JosiGhost(mood: mood, size: 56)
            if thinking {
                Text("Josi is thinking").font(JosiFont.caption).foregroundStyle(JosiTheme.gold).padding(.horizontal, 12).padding(.vertical, 6)
                    .background(JosiTheme.gold.opacity(0.1), in: Capsule()).overlay(Capsule().stroke(JosiTheme.hairline, lineWidth: 1))
            }
            Spacer()
        }.accessibilityElement(children: .combine)
    }
    @ViewBuilder private func messageRow(_ message: Wire) -> some View {
        if message["direction"].text == "in" {
            HStack {
                Spacer(minLength: 70)
                VStack(alignment: .trailing, spacing: 7) {
                    VStack(alignment: .leading, spacing: 8) {
                        attachments(message)
                        Text(message["body"].text).textSelection(.enabled).lineSpacing(4)
                    }.padding(.horizontal, 14).padding(.vertical, 11).foregroundStyle(JosiTheme.onGold)
                        .background(JosiTheme.goldGradient, in: UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 5))
                }.frame(maxWidth: 640, alignment: .trailing)
            }
        } else {
            HStack(alignment: .top, spacing: 10) {
                JosiMarkTile(size: 28)
                VStack(alignment: .leading, spacing: 8) {
                    Text(.init(message["body"].text)).textSelection(.enabled).lineSpacing(5).padding(.horizontal, 14).padding(.vertical, 11)
                        .background(JosiTheme.card, in: UnevenRoundedRectangle(topLeadingRadius: 5, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 16))
                        .overlay(UnevenRoundedRectangle(topLeadingRadius: 5, bottomLeadingRadius: 16, bottomTrailingRadius: 16, topTrailingRadius: 16).stroke(JosiTheme.border.opacity(0.6), lineWidth: 1))
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
        ForEach(message["attachments"].list, id: \.identifier) { item in Label(item["filename"].text, systemImage: "paperclip").font(JosiFont.caption).foregroundStyle(JosiTheme.muted) }
    }
    private var composer: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !model.draftAttachments.isEmpty {
                ScrollView(.horizontal) { HStack {
                    ForEach(model.draftAttachments, id: \.identifier) { item in
                        HStack { Image(systemName: "paperclip"); Text(item["filename"].text).lineLimit(1)
                            Button { model.draftAttachments.removeAll { $0.identifier == item.identifier } } label: { Image(systemName: "xmark.circle.fill") }
                                .buttonStyle(.plain).help("Remove attachment from message")
                        }.font(JosiFont.caption).padding(8).background(JosiTheme.card, in: Capsule())
                    }
                } }
            }
            if !voice.partial.isEmpty { Text(voice.partial).font(JosiFont.callout).foregroundStyle(JosiTheme.muted).lineLimit(3) }
            if !voice.error.isEmpty { Text(voice.error).font(JosiFont.caption).foregroundStyle(JosiTheme.error).textSelection(.enabled) }
            HStack(alignment: .bottom, spacing: 10) {
                Button(action: attach) { Image(systemName: "plus").font(.system(size: 15, weight: .semibold)).frame(width: 38, height: 38) }
                    .buttonStyle(.plain).foregroundStyle(JosiTheme.lilac).help("Attach a file or photo").accessibilityLabel("Attach a file or photo")
                    .disabled(model.busy || model.pendingMessage || model.draftAttachments.count >= 10 || voice.mode != nil)
                Rectangle().fill(JosiTheme.border).frame(width: 1, height: 24).padding(.bottom, 7)
                ZStack(alignment: .topLeading) {
                    if model.draft.isEmpty { Text("Message Josi…").foregroundStyle(JosiTheme.muted).padding(.top, 9).padding(.leading, 8).allowsHitTesting(false) }
                    JosiMessageEditor(text: $model.draft, enabled: !model.pendingMessage && voice.mode != .conversation, onSend: send)
                        .frame(height: min(120, max(38, CGFloat(model.draft.filter { $0 == "\n" }.count + 1) * 21 + 17)))
                }
                Button { toggleVoice(.dictation) } label: { Image(systemName: voice.mode == .dictation ? "stop.fill" : "mic").font(.system(size: 15)).frame(width: 38, height: 38) }
                    .buttonStyle(.plain).foregroundStyle(voice.mode == .dictation ? JosiTheme.error : JosiTheme.gold).help("Dictate").accessibilityLabel("Dictate")
                    .disabled(model.pendingMessage || voice.starting || voice.mode == .conversation)
                if JosiFlags.talk, !canSend, voice.mode == nil {
                    Button { toggleVoice(.conversation) } label: { Image(systemName: "waveform").frame(width: 38, height: 38) }.buttonStyle(.plain).help("Voice chat")
                }
                Button(action: send) { Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)).frame(width: 38, height: 38).foregroundStyle(JosiTheme.onGold).background(JosiTheme.goldGradient, in: Circle()) }
                    .buttonStyle(.plain).disabled(!canSend).opacity(canSend ? 1 : 0.5).help(model.pendingMessage ? "Retry delivery" : "Send message")
                    .accessibilityLabel(model.pendingMessage ? "Retry delivery" : "Send message")
            }
        }.padding(.vertical, 8).padding(.leading, 10).padding(.trailing, 8).background(JosiFrost().clipShape(RoundedRectangle(cornerRadius: 18)))
            .overlay(RoundedRectangle(cornerRadius: 18).stroke(JosiTheme.hairline, lineWidth: 1))
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
        guard voice.available else {
            if JosiFlags.voiceBox { voiceSettings = true } else { voice.error = "Voice isn’t set up on this server." }
            return
        }
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
extension String { var nonempty: String? { isEmpty ? nil : self } }

struct JosiChipStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(JosiFont.body(12.5)).padding(.horizontal, 12).padding(.vertical, 7).foregroundStyle(JosiTheme.text)
            .background(JosiTheme.card.opacity(0.7), in: Capsule()).overlay(Capsule().stroke(JosiTheme.gold.opacity(0.35), lineWidth: 1))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}
