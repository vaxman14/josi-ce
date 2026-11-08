import Foundation
import CryptoKit

/// Isolated acceptance driver: ephemeral key, synthetic account, loopback
/// server and one exact disposable folder. No Keychain, UI, TCC or installation.
@main struct ComputerHTTPProbe {
    @MainActor static func main() async throws {
        guard CommandLine.arguments.count == 2 else { throw JosiError(message: "Choose a synthetic fixture.") }
        let fixture = try JSONDecoder().decode(Wire.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        guard let origin = URL(string: fixture["origin"].text), origin.host == "127.0.0.1", origin.scheme == "http",
              fixture["root"].text.hasPrefix("/private/") else { throw JosiError(message: "This probe only accepts isolated local fixtures.") }
        let owner = fixture["owner"].text, root = fixture["root"].text
        let key = ComputerDeviceKey(key: Curve25519.Signing.PrivateKey()), gate = ComputerLocalGate()
        func request(_ path: String, _ body: Wire) async throws -> Wire {
            var request = URLRequest(url: origin.appendingPathComponent("api/computer-control/" + path))
            request.httpMethod = "POST"; request.timeoutInterval = 5
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("native", forHTTPHeaderField: "X-Josi-Client")
            request.setValue("Bearer " + fixture["token"].text, forHTTPHeaderField: "Authorization")
            request.httpBody = try JSONEncoder().encode(body)
            let (bytes, response) = try await URLSession.shared.data(for: request)
            guard let response = response as? HTTPURLResponse, response.statusCode == 200 else { throw JosiError(message: "Isolated HTTP acceptance request failed.") }
            return try JSONDecoder().decode(Wire.self, from: bytes)
        }
        func call(_ method: String, _ body: Wire = [:]) async throws -> Wire {
            try await request("device/" + method, ["proof": key.proof(owner: owner, method: method, body: body)])
        }
        let enrollment = try key.proof(owner: owner, method: "enroll", body: ["publicKey": .string(key.publicKey), "platform": "macos", "label": "Isolated Swift acceptance"])
        _ = try await request("enroll", ["password": fixture["password"], "proof": enrollment])
        _ = try await call("presence", ["capabilities": .array([.string("file.read"), .string("file.write")])])
        FileHandle.standardOutput.write(Data(("READY " + key.id + "\n").utf8))
        gate.resume()
        let deadline = Date().addingTimeInterval(20)
        var completed = 0
        while Date() < deadline, completed < 2 {
            let response = try await call("next")
            let q = response["request"]
            if q == .null { try await Task.sleep(for: .milliseconds(50)); continue }
            guard q["operation"]["scope"]["target"].text == root else { throw JosiError(message: "Unexpected acceptance folder.") }
            try gate.begin(q, device: response["device"], owner: owner, deviceId: key.id)
            try gate.check()
            let result = try ComputerFiles.execute(q["operation"])
            try gate.check()
            _ = try await call("result", ["requestId": q["id"], "ok": .bool(true), "result": result])
            gate.finish(); completed += 1
        }
        guard completed == 2 else { throw JosiError(message: "Native acceptance timed out.") }
        gate.stop()
        _ = try await call("stop")
        FileHandle.standardOutput.write(Data("PASS Swift HTTP file round trip and local Stop\n".utf8))
    }
}
