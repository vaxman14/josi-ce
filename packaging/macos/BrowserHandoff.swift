import Foundation

final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
enum BrowserHandoff {
    static func issue(address: String, bootstrap: String) async throws -> String {
        guard let base = URL(string: address), base.scheme == "http", base.host == "localhost", let port = base.port, (1024...65535).contains(port),
              bootstrap.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw NSError(domain: "JosiHandoff", code: 1) }
        let config = URLSessionConfiguration.ephemeral; config.timeoutIntervalForRequest = 10
        let session = URLSession(configuration: config, delegate: NoRedirects(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        func object(_ request: URLRequest) async throws -> [String: Any] {
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200, data.count < 8192,
                  let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw NSError(domain: "JosiHandoff", code: 2) }
            return value
        }
        let state = try await object(URLRequest(url: URL(string: address + "/api/onboarding/state")!))
        guard let completed = state["completed"] as? Bool else { throw NSError(domain: "JosiHandoff", code: 3) }
        if completed { return address + "/" }
        let csrf = try await object(URLRequest(url: URL(string: address + "/api/auth/csrf")!))
        guard let token = csrf["csrfToken"] as? String, !token.isEmpty, token.count <= 256 else { throw NSError(domain: "JosiHandoff", code: 4) }
        var request = URLRequest(url: URL(string: address + "/api/onboarding/launch")!)
        request.httpMethod = "POST"; request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-josi-csrf")
        request.setValue(bootstrap, forHTTPHeaderField: "x-josi-setup-token")
        let reply = try await object(request)
        guard let once = reply["token"] as? String, once.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw NSError(domain: "JosiHandoff", code: 5) }
        return address + "/setup#handoff=" + once
    }
}
