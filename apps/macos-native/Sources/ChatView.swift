import AppKit
import SwiftUI

/// Chat is the whole window: Josi big in the middle, the current line under her,
/// and the conversation in a panel that rises over the stage.
struct ChatView: View {
    @EnvironmentObject var model: JosiModel
    @StateObject private var voice = NativeVoice()
    @State private var voiceSettings = false
    /// True from a send until its outcome. Loading an old conversation brings in
    /// replies and failures too, and those must not play as if they just happened.
    @State private var waiting = false
    @State private var followedThread: String?
    @State private var followedReply: String?
    @State private var followedFailure: String?
    @State private var followedError = ""
    @State private var followedGoals: [String: String] = [:]
    @State private var freshReply: String?
    private static let lineHeight: CGFloat = 200
    private static let acknowledgements = ["I got you.", "Consider it handled. Well, almost.", "On it. Try to contain your excitement.", "Oh, I like this one. Give me a sec.", "Say less."]
    private static let suggestions = ["What’s on my calendar today?", "Remind me to call Dana", "Draft a note to the team"]
    private var firstName: String { model.signedInName.split(separator: " ").first.map(String.init) ?? "" }
    private var thinking: Bool { (model.pendingMessage && model.busy) || model.turns.contains { ["queued", "running"].contains($0["status"].text) } }
    private var canSend: Bool { !model.busy && (model.pendingMessage || !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
    private var lastReply: Wire? { model.messages.last { $0["direction"].text != "in" } }
    private var lastFailure: Wire? { model.turns.last { $0["status"].text == "failed" } }
    /// Everything that can move the ghost.
    private var followed: [String] {
        [model.selectedThread ?? "", lastReply?.identifier ?? "", lastFailure?.identifier ?? "", model.error, String(thinking),
         String(model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty), String(voice.mode != nil)]
            + model.chatGoals.map { $0["goalId"].text + $0["state"].text }
    }
    /// The failure the stage shows: the latest message's, or one with no message of its own.
    private var stageFailure: Wire? {
        guard let failed = lastFailure else { return nil }
        let inbound = failed["inbound_message_id"].text
        return model.messages.last?.identifier == inbound || !model.messages.contains { $0.identifier == inbound } ? failed : nil
    }
    private var stageKey: String {
        [model.selectedThread ?? "", model.messages.last?.identifier ?? "", String(thinking), stageFailure?.identifier ?? ""].joined(separator: "|")
    }
    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                stage
                composer.padding(.horizontal, 26).padding(.top, 8).padding(.bottom, 8).frame(maxWidth: 830)
                Text(footer).font(JosiFont.caption).foregroundStyle(JosiTheme.muted).padding(.bottom, 14)
            }
            if model.historyOpen { history.transition(.move(edge: .bottom)) }
        }
        .sheet(isPresented: $voiceSettings) { NativeVoiceSettings(voice: voice).environmentObject(model).preferredColorScheme(.dark) }
        .task {
            guard let api = model.api else { return }
            await voice.refresh(api, administrator: model.isAdministrator)
            if model.isAdministrator, let primary = try? await api.request("/admin/llm") {
                let value = primary["primary"]
                model.modelName = value["provider"].text == "openai_subscription" ? "ChatGPT plan" : value["model"].text
            }
        }
        .onChange(of: model.selectedThread) { _, _ in voice.stop() }
        .onChange(of: followed, initial: true) { _, _ in follow() }
        .onDisappear { voice.stop(); model.showHistory(false) }
    }
    /// Tells the ghost what just changed. A thread's existing replies, goals and
    /// errors are history, so opening it plays nothing.
    private func follow() {
        let ghost = model.ghost
        let reply = lastReply, replyId = reply?.identifier, failureId = lastFailure?.identifier
        if followedThread != model.selectedThread {
            followedThread = model.selectedThread; followedReply = replyId; followedFailure = failureId; followedGoals = [:]
            model.showHistory(false)
            for goal in model.chatGoals { followedGoals[goal["goalId"].text] = goal["state"].text }
        } else {
            if thinking { waiting = true }
            if replyId != followedReply {
                followedReply = replyId
                if let reply, waiting { waiting = false; freshReply = replyId; ghost.replied(reply["body"].text) }
            }
            if failureId != followedFailure {
                followedFailure = failureId
                if failureId != nil, waiting { waiting = false; ghost.set(.error) }
            }
            for goal in model.chatGoals {
                let id = goal["goalId"].text, state = goal["state"].text
                if state == "completed", let before = followedGoals[id], before != state { ghost.set(.taskDone) }
                followedGoals[id] = state
            }
        }
        if !model.error.isEmpty, model.error != followedError { ghost.set(.error) }
        followedError = model.error
        ghost.set(voice.mode != nil ? .voice : thinking ? .waiting : !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .typing : .idle)
    }
    private var footer: String {
        model.pendingMessage ? "Delivery is unconfirmed. Retry keeps the same message and attachments." : "Enter to send · Shift + Enter for a new line"
    }
    private var stage: some View {
        GeometryReader { room in
            VStack(spacing: 0) {
                Spacer(minLength: 0)
                JosiGhost(ghost: model.ghost, size: max(170, min(480, room.size.height - Self.lineHeight - 4, room.size.width * 0.7)))
                VStack(spacing: 12) {
                    line.id(stageKey).transition(JosiMotion.still ? .identity : .opacity.combined(with: .offset(y: 18)))
                    if model.ghost.state == .thinking { thinkingChip }
                }.frame(maxWidth: 760).padding(.horizontal, 24).padding(.top, 10)
                    .frame(height: Self.lineHeight, alignment: .top)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
                .animation(.easeOut(duration: 0.42), value: stageKey)
        }
    }
    private var thinkingChip: some View {
        Text("Josi is thinking").font(JosiFont.caption).foregroundStyle(JosiTheme.gold).padding(.horizontal, 12).padding(.vertical, 6)
            .background(JosiTheme.gold.opacity(0.1), in: Capsule()).overlay(Capsule().stroke(JosiTheme.hairline, lineWidth: 1))
    }
    /// The one thing under the ghost: a short acknowledgement while Josi works, then her reply.
    @ViewBuilder private var line: some View {
        let last = model.messages.last
        if let failed = stageFailure {
            VStack(spacing: 8) { speaker; ChatTurnFailure(turn: failed) }
        } else if last == nil, !thinking {
            greeting
        } else if last?["direction"].text == "in" || thinking {
            let seed = (last?.identifier ?? "").unicodeScalars.reduce(0) { $0 + Int($1.value) }
            VStack(spacing: 7) { speaker; sentence(Self.acknowledgements[seed % Self.acknowledgements.count]) }
        } else if let last {
            StageReply(message: last, animate: freshReply == last.identifier && !JosiMotion.still, open: { model.showHistory(true) })
        }
    }
    private var speaker: some View { Text("JOSI").font(JosiFont.body(11, weight: .semibold)).foregroundStyle(JosiTheme.muted) }
    private func sentence(_ text: String) -> some View {
        Text(text).font(JosiFont.body(20, weight: .medium)).multilineTextAlignment(.center).lineLimit(4)
            .contentShape(Rectangle()).onTapGesture { model.showHistory(true) }.help("Open the conversation")
    }
    private var greeting: some View {
        VStack(spacing: 6) {
            Text(firstName.isEmpty ? "Hi, I’m Josi." : "Hi \(firstName), I’m Josi.").font(JosiFont.display(24))
            Text("Go on, give me something good to do.").foregroundStyle(JosiTheme.lilac)
            HStack(spacing: 8) {
                ForEach(Self.suggestions, id: \.self) { text in
                    Button(text) { model.draft = text; send() }.buttonStyle(JosiChipStyle()).disabled(model.busy)
                }
            }.padding(.top, 12)
        }
    }
    /// The whole conversation, in a panel that rises over the stage.
    private var history: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Chat history").font(JosiFont.display(20))
                    Text(model.threads.first { $0.identifier == model.selectedThread }?["title"].text.nonempty ?? "Conversation")
                        .font(JosiFont.caption).foregroundStyle(JosiTheme.muted).lineLimit(1)
                }
                Spacer()
                Button { model.showHistory(false) } label: { Image(systemName: "xmark") }
                    .buttonStyle(JosiIconButtonStyle()).help("Close chat history").accessibilityLabel("Close chat history")
            }.padding(.horizontal, 28).padding(.top, 18).padding(.bottom, 14)
            Rectangle().fill(JosiTheme.hairline).frame(height: 1)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        ForEach(model.messages, id: \.identifier) { message in
                            messageRow(message).id(message.identifier)
                            ForEach(model.turns.filter { $0["status"].text == "failed" && $0["inbound_message_id"].text == message.identifier }, id: \.identifier) { ChatTurnFailure(turn: $0) }
                        }
                        ForEach(model.chatGoals, id: \.identifier) { GoalCard(goal: $0, compact: true) }
                        ForEach(model.turns.filter { turn in turn["status"].text == "failed" && !model.messages.contains { $0.identifier == turn["inbound_message_id"].text } }, id: \.identifier) { ChatTurnFailure(turn: $0) }
                        Color.clear.frame(height: 1).id("latest")
                    }.padding(.horizontal, 30).padding(.vertical, 24).frame(maxWidth: 900).frame(maxWidth: .infinity)
                }
                .onAppear { proxy.scrollTo("latest", anchor: .bottom) }
                .onChange(of: model.messages.last?.identifier) { _, _ in withAnimation { proxy.scrollTo("latest", anchor: .bottom) } }
            }
        }.background(JosiTheme.deep).frame(maxWidth: .infinity, maxHeight: .infinity)
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
        voice.stop()
        model.ghost.set(.received)
        waiting = true
        model.run { try await model.send() }
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
/// Josi's reply under the ghost. A fresh one comes in word by word: every word is
/// laid out from the start, unseen, so nothing jumps. Its list follows, one row at a time.
private struct StageReply: View {
    let message: Wire
    let animate: Bool
    let open: () -> Void
    @State private var shown = 0
    @State private var rows = 0
    private var parts: JosiReply { JosiReply(message["body"].text) }
    private var text: AttributedString {
        let lead = parts.lead
        return (try? AttributedString(markdown: lead, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(lead)
    }
    private func starts(_ text: AttributedString) -> [AttributedString.Index] {
        var result: [AttributedString.Index] = []; var inWord = false
        for index in text.characters.indices {
            let space = text.characters[index].isWhitespace
            if !space, !inWord { result.append(index) }
            inWord = !space
        }
        return result
    }
    private var visible: AttributedString {
        var value = text
        let words = starts(value)
        if animate, shown < words.count { value[words[shown]..<value.endIndex].foregroundColor = .clear }
        return value
    }
    var body: some View {
        let items = parts.items.prefix(5)
        VStack(spacing: 8) {
            Text("JOSI").font(JosiFont.body(11, weight: .semibold)).foregroundStyle(JosiTheme.muted)
            if !parts.lead.isEmpty {
                Text(visible).font(JosiFont.body(20, weight: .medium)).multilineTextAlignment(.center).lineLimit(4).truncationMode(.tail)
                    .contentShape(Rectangle()).onTapGesture(perform: open).help("Open the conversation")
            }
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { at, item in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(at + 1)").font(JosiFont.body(15, weight: .bold)).foregroundStyle(JosiTheme.gold)
                        Text(.init(item)).font(JosiFont.body(15)).lineLimit(1)
                    }.opacity(!animate || at < rows ? 1 : 0)
                }
                if parts.items.count > 5 { Text("And \(parts.items.count - 5) more").font(JosiFont.body(13)).foregroundStyle(JosiTheme.muted).opacity(!animate || rows >= 5 ? 1 : 0) }
            }
        }.task {
            guard animate else { return }
            let words = starts(text).count
            for at in 0..<words {
                try? await Task.sleep(for: .milliseconds(max(16, JosiReply.revealStep(words: words))))
                if Task.isCancelled { return }
                shown = at + 1
            }
            for at in 0..<min(5, parts.items.count) {
                withAnimation(.easeOut(duration: 0.32)) { rows = at + 1 }
                try? await Task.sleep(for: .milliseconds(180))
                if Task.isCancelled { return }
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
