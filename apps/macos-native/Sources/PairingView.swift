import SwiftUI

/// Pairing on the connect screen. The code leaves the field as soon as it's used.
struct TunnelPairingPanel: View {
    @EnvironmentObject var model: JosiModel
    @State private var input = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            ForEach(model.pairings) { pairing in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(pairing.title)
                        Text(pairing.host).font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Open") { model.run { try await model.open(pairing) } }.buttonStyle(.borderedProminent)
                    Button("Forget") { model.run { try model.forget(pairing) } }
                }
            }
            Text("Pair with a code").font(.headline)
            TextField("Pairing code or link", text: $input)
                .textFieldStyle(.roundedBorder).autocorrectionDisabled().onSubmit(pair)
            Button("Pair", action: pair).disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            Text("Encrypted from this Mac to your server. The relay can’t read it.")
                .font(.caption).foregroundStyle(.secondary)
        }.task { model.loadPairings() }
    }
    private func pair() {
        let value = input
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        input = ""
        model.run { try await model.pair(value) }
    }
}

/// How this Mac reaches a paired server, shown with the server's health.
struct TunnelServerStatus: View {
    @EnvironmentObject var model: JosiModel
    let tunnel: TunnelConnection
    @State private var path = TunnelPath.none
    @State private var replaced = false
    var body: some View {
        HStack {
            Text(path == .lan ? "Connected directly on your network" : path == .relay ? "Connected through the relay" : "Encrypted connection")
                .font(.caption).foregroundStyle(.secondary)
            Spacer()
            if replaced { Text("Key replaced").font(.caption).foregroundStyle(.secondary) }
            Button("Replace Device Key") {
                replaced = false
                model.run { try await model.rotateDeviceKey(); replaced = true }
            }.disabled(model.busy)
        }.task(id: model.busy) { path = await tunnel.path }
    }
}
