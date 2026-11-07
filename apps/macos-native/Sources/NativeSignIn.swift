import AppKit
import AuthenticationServices
import CryptoKit

/// The system sign-in sheets. Google and passkeys open the server's own page in
/// a browser session, because a self-hosted address can't be an app's associated
/// domain. Apple uses the native sheet and needs the app's Apple entitlement.
@MainActor final class NativeSignIn: NSObject, ASWebAuthenticationPresentationContextProviding,
                                     ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    private static var active: NativeSignIn?
    private var session: ASWebAuthenticationSession?
    private var appleResult: CheckedContinuation<ASAuthorizationAppleIDCredential, Error>?
    private var anchor: NSWindow { NSApp.keyWindow ?? NSApp.windows.first { $0.canBecomeMain } ?? NSWindow() }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { anchor }
    }
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        MainActor.assumeIsolated { anchor }
    }

    static func browser(start: URL, state: String? = nil) async throws -> String {
        let items = try await callback(start: start, state: state)
        if let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty { return code }
        throw failure(items)
    }
    /// Adds a passkey on the server's page. The caller confirms it with the server.
    static func addPasskey(start: URL, state: String) async throws {
        let items = try await callback(start: start, state: state)
        if items.first(where: { $0.name == "added" })?.value != "1" { throw failure(items) }
    }
    private static func callback(start: URL, state: String?) async throws -> [URLQueryItem] {
        let flow = NativeSignIn(); active = flow; defer { active = nil }
        let callback: URL = try await withCheckedThrowingContinuation { result in
            let session = ASWebAuthenticationSession(url: start, callbackURLScheme: "josi") { url, error in
                if let url { result.resume(returning: url) }
                else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin { result.resume(throwing: CancellationError()) }
                else { result.resume(throwing: JosiError(message: "Sign-in could not open. Try again, or use your password.")) }
            }
            session.presentationContextProvider = flow
            flow.session = session
            if !session.start() { result.resume(throwing: JosiError(message: "Sign-in could not open. Try again, or use your password.")) }
        }
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        // A callback for a sign-in this app didn't start is refused outright.
        if let state, items.first(where: { $0.name == "state" })?.value != state {
            throw JosiError(message: "That sign-in didn’t match this app. Try again.")
        }
        return items
    }
    private static func failure(_ items: [URLQueryItem]) -> Error {
        switch items.first(where: { $0.name == "error" })?.value ?? "" {
        case "passkey_cancelled", "google_declined": return CancellationError()
        case "google_not_linked": return JosiError(message: "That Google account isn’t linked to anyone on this server.")
        case "google_unavailable": return JosiError(message: "Google sign-in isn’t set up on this server.")
        default: return JosiError(message: "That didn’t work. Try again, or use your password.")
        }
    }

    static func apple() async throws -> (token: String, nonce: String, user: String) {
        let nonce = Data((0..<32).map { _ in UInt8.random(in: .min ... .max) }).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        let flow = NativeSignIn(); active = flow; defer { active = nil }
        let credential: ASAuthorizationAppleIDCredential = try await withCheckedThrowingContinuation { result in
            flow.appleResult = result
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.email]
            request.nonce = SHA256.hash(data: Data(nonce.utf8)).map { String(format: "%02x", $0) }.joined()
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = flow; controller.presentationContextProvider = flow
            controller.performRequests()
        }
        guard let data = credential.identityToken, let token = String(data: data, encoding: .utf8) else {
            throw JosiError(message: "Apple didn’t return a sign-in. Try again, or use your password.")
        }
        return (token, nonce, credential.user)
    }

    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        nonisolated(unsafe) let value = authorization.credential as? ASAuthorizationAppleIDCredential
        MainActor.assumeIsolated {
            if let value { appleResult?.resume(returning: value) }
            else { appleResult?.resume(throwing: JosiError(message: "Apple didn’t return a sign-in.")) }
            appleResult = nil
        }
    }
    nonisolated func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        let cancelled = (error as? ASAuthorizationError)?.code == .canceled
        MainActor.assumeIsolated {
            appleResult?.resume(throwing: cancelled ? CancellationError() : JosiError(message: "Sign in with Apple isn’t available in this build of Josi. Use your password."))
            appleResult = nil
        }
    }
}
