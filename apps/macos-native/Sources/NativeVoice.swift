import AppKit
import AVFoundation
import SwiftUI

/// Audio callbacks are isolated from the main actor. Only PCM bytes cross back
/// to it; raw audio is sent to this signed-in Josi server's existing Voice Box.
private final class JosiAudioCapture: @unchecked Sendable {
    private let engine = AVAudioEngine()
    func start(deliver: @escaping @Sendable (Data) -> Void) throws {
        let input = engine.inputNode
        try input.setVoiceProcessingEnabled(true)
        let source = input.outputFormat(forBus: 0)
        guard source.sampleRate > 0, source.channelCount > 0,
              let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: source, to: target) else {
            throw JosiError(message: "Choose an available microphone in macOS Sound settings.")
        }
        let conversion = JosiPCMConversion(converter: converter, format: target)
        input.installTap(onBus: 0, bufferSize: 4096, format: source) { buffer, _ in
            if let data = conversion.convert(buffer) { deliver(data) }
        }
        engine.prepare()
        do { try engine.start() } catch { input.removeTap(onBus: 0); throw error }
    }
    func stop() { if engine.isRunning { engine.stop(); engine.inputNode.removeTap(onBus: 0) } }
}
private final class JosiPCMConversion: @unchecked Sendable {
    let converter: AVAudioConverter
    let format: AVAudioFormat
    init(converter: AVAudioConverter, format: AVAudioFormat) { self.converter = converter; self.format = format }
    func convert(_ input: AVAudioPCMBuffer) -> Data? {
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * 16_000 / input.format.sampleRate)) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, flag in
            if supplied { flag.pointee = .noDataNow; return nil }
            supplied = true; flag.pointee = .haveData; return input
        }
        guard status != .error, error == nil, let samples = output.floatChannelData?[0] else { return nil }
        var data = Data(capacity: Int(output.frameLength) * 2)
        for index in 0..<Int(output.frameLength) {
            let sample = Int16(max(-1, min(1, samples[index])) * 32767)
            let bits = UInt16(bitPattern: sample)
            data.append(UInt8(bits & 255)); data.append(UInt8(bits >> 8))
        }
        return data.isEmpty ? nil : data
    }
}

@MainActor final class NativeVoice: ObservableObject {
    enum Mode { case dictation, conversation }
    @Published var available = false
    @Published var starting = false
    @Published var mode: Mode?
    @Published var partial = ""
    @Published var error = ""
    @Published var speaking = false
    @Published var settings: Wire = .null
    private var capture: JosiAudioCapture?
    private var api: JosiAPI?
    private var session = ""
    private var frames = Data()
    private var sequence = 0
    private var generation = 0
    private var speechGeneration = 0
    private var pump: Task<Void, Never>?
    private var turnChain: Task<Void, Never>?
    private var pendingTurns = 0
    private var player: AVAudioPlayer?
    private var onText: ((String) async throws -> String?)?
    var modelLabel: String {
        if !available { return "Voice Box · Setup" }
        let voice = settings["settings"]["voice"].text
        return voice == "af_bella" ? "Kokoro · Bella" : voice == "af_heart" ? "Kokoro · Heart" : "Voice Box · Ready"
    }
    func refresh(_ api: JosiAPI, administrator: Bool) async {
        do {
            available = try await api.request("/voice/status")["available"].flag
            if administrator { settings = try await api.request("/admin/voice-box") }
        } catch { available = false; self.error = error.localizedDescription }
    }
    func start(_ mode: Mode, api: JosiAPI, onText: @escaping (String) async throws -> String?) async {
        guard self.mode == nil, !starting else { return }
        starting = true; error = ""; generation += 1
        let mine = generation
        defer { if mine == generation { starting = false } }
        do {
            let allowed = await AVCaptureDevice.requestAccess(for: .audio)
            guard mine == generation else { return }
            guard allowed else { throw JosiError(message: "Allow Josi to use the microphone in System Settings → Privacy & Security → Microphone.") }
            let opened = try await api.request("/voice/session", method: "POST", body: [:])["session"].text
            guard opened.range(of: "^[a-f0-9]{48}$", options: .regularExpression) != nil else { throw JosiError(message: "Voice Box could not open a session.") }
            guard mine == generation else { _ = try? await api.request("/voice/close", method: "POST", body: ["session": .string(opened)]); return }
            self.api = api; self.session = opened; self.onText = onText; self.mode = mode
            self.sequence = 0; frames.removeAll(); partial = ""
            let capture = JosiAudioCapture(); self.capture = capture
            try capture.start { [weak self] bytes in
                Task { @MainActor [weak self] in self?.enqueue(bytes, generation: mine) }
            }
        } catch { self.error = error.localizedDescription; stop() }
    }
    private func enqueue(_ bytes: Data, generation mine: Int) {
        guard mine == generation, mode != nil else { return }
        frames.append(bytes)
        if frames.count > 480_000 { error = "Voice processing is falling behind. Stop other workloads and try again."; stop(); return }
        guard pump == nil, let api else { return }
        let opened = session
        pump = Task {
            defer { if mine == generation { pump = nil } }
            do {
                while !frames.isEmpty, mine == generation, !Task.isCancelled {
                    let count = min(32_000, frames.count)
                    let pcm = Data(frames.prefix(count)); frames.removeFirst(count)
                    let body: Wire = ["session": .string(opened), "seq": .number(Double(sequence)), "pcm": .string(pcm.base64EncodedString())]
                    let result: Wire
                    do { result = try await api.request("/voice/audio", method: "POST", body: body) }
                    catch let failure as JosiError where failure.status == 429 {
                        try await Task.sleep(for: .milliseconds(250))
                        try Task.checkCancellation()
                        result = try await api.request("/voice/audio", method: "POST", body: body)
                    }
                    guard mine == generation else { break }
                    sequence += 1
                    for event in result["events"].list {
                        switch event["type"].text {
                        case "speech_start": interrupt()
                        case "partial": partial = event["text"].text
                        case "final":
                            let text = event["text"].text.trimmingCharacters(in: .whitespacesAndNewlines)
                            partial = ""
                            if !text.isEmpty { accept(text, generation: mine) }
                        default: break
                        }
                    }
                }
            } catch {
                if mine == generation, !Task.isCancelled { self.error = error.localizedDescription; stop() }
            }
        }
    }
    private func accept(_ text: String, generation mine: Int) {
        guard let onText, pendingTurns < 3 else { error = "Please wait for Josi to finish answering."; return }
        let previous = turnChain; pendingTurns += 1
        turnChain = Task {
            await previous?.value
            guard mine == generation, !Task.isCancelled else { return }
            defer { if mine == generation { pendingTurns -= 1 } }
            do {
                let reply = try await onText(text)
                if let reply, mode == .conversation, mine == generation, let api { try await speak(reply, api: api) }
            } catch { if mine == generation { self.error = error.localizedDescription } }
        }
    }
    func speak(_ text: String, api: JosiAPI) async throws {
        interrupt(); let mine = speechGeneration
        speaking = true
        defer { if mine == speechGeneration { speaking = false; player = nil } }
        var remaining = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while !remaining.isEmpty, mine == speechGeneration, !Task.isCancelled {
            let chunk = String(remaining.prefix(400)); remaining.removeFirst(chunk.count)
            let data = try await api.voiceAudio("/voice/speech", body: ["text": .string(chunk)])
            guard mine == speechGeneration, !Task.isCancelled else { return }
            let audio = try AVAudioPlayer(data: data); player = audio
            guard audio.play() else { throw JosiError(message: "Josi could not play the voice reply.") }
            while audio.isPlaying, mine == speechGeneration, !Task.isCancelled { try await Task.sleep(for: .milliseconds(80)) }
        }
    }
    func interrupt() { speechGeneration += 1; player?.stop(); player = nil; speaking = false }
    func stop() {
        generation += 1; starting = false; capture?.stop(); capture = nil; mode = nil; partial = ""
        frames.removeAll(); interrupt(); turnChain?.cancel(); turnChain = nil; pendingTurns = 0
        let previous = pump; pump?.cancel(); pump = nil
        let api = self.api, opened = session
        self.api = nil; session = ""; onText = nil
        if let api, !opened.isEmpty {
            Task { await previous?.value; _ = try? await api.request("/voice/close", method: "POST", body: ["session": .string(opened)]) }
        }
    }
}

struct NativeVoiceSettings: View {
    @EnvironmentObject var model: JosiModel
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var voice: NativeVoice
    @State private var selected = "af_heart"
    @State private var transcription = "base.en"
    @State private var working = false
    @State private var error = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack { Text("Voice Box").font(.title2.bold()); Spacer(); Button("Done") { dismiss() } }
            Text("Dictate into the message box, or talk with Josi and hear its replies. Audio is processed by Voice Box on your Josi server.").foregroundStyle(JosiTheme.muted)
            Label(voice.available ? "Speech models are ready" : "Voice Box needs setup", systemImage: voice.available ? "checkmark.circle" : "waveform")
            if model.isAdministrator {
                if voice.settings["verified"].flag {
                    Picker("Speaking voice", selection: $selected) { Text("Kokoro · Heart").tag("af_heart"); Text("Kokoro · Bella").tag("af_bella") }
                    Picker("Dictation model", selection: $transcription) { Text("Whisper Base · English").tag("base.en"); Text("Whisper Tiny · English").tag("tiny.en") }
                    Button("Save voice settings") { perform("settings") }.buttonStyle(JosiPillStyle(prominent: true))
                    Button("Restart Voice Box") { perform("restart") }
                } else {
                    Text(voice.settings["error"].text.isEmpty ? "Enable the included local speech models to use voice controls." : voice.settings["error"].text)
                    Button("Enable Voice Box") { perform("install") }.buttonStyle(JosiPillStyle(prominent: true))
                        .disabled(!voice.settings["helperAvailable"].flag || !voice.settings["releaseAvailable"].flag)
                }
            } else { Text("Your server administrator manages the voice models.") }
            if !error.isEmpty { Text(error).foregroundStyle(JosiTheme.orange) }
            if working { ProgressView("Checking speech models…") }
        }.padding(28).frame(width: 480).background(JosiTheme.background).disabled(working)
            .task { await refresh() }
    }
    private func refresh() async {
        guard let api = model.api else { return }
        await voice.refresh(api, administrator: model.isAdministrator)
        if !voice.settings["settings"]["voice"].text.isEmpty { selected = voice.settings["settings"]["voice"].text; transcription = voice.settings["settings"]["model"].text }
    }
    private func perform(_ operation: String) {
        guard let api = model.api else { return }; working = true; error = ""
        Task {
            defer { working = false }
            do {
                var body: Wire = [:]
                if operation == "settings", case .object(var saved) = voice.settings["settings"] {
                    saved["voice"] = .string(selected); saved["model"] = .string(transcription); body = .object(saved)
                }
                _ = try await api.request("/admin/voice-box/" + operation, method: "POST", body: body)
                for _ in 0..<20 {
                    await refresh()
                    if voice.available || voice.settings["phase"].text != "working" { break }
                    try await Task.sleep(for: .seconds(2))
                }
            } catch { self.error = error.localizedDescription }
        }
    }
}
