import Foundation

/// Keep the failure at its actual stage. HTTP errors are already bounded by
/// JosiAPI; never print native exceptions, key material or request bodies.
enum EnrollmentStage: String {
    case begin = "starting enrollment"
    case createKey = "creating this Mac’s protected key"
    case prepare = "verifying your Josi administrator account and preparing the review"
    case connectReview = "connecting to the server Mac’s enrollment review"
    case review = "reviewing the exact enrollment"
    case authenticate = "authenticating the reviewed enrollment with Touch ID"
    case returnToReview = "returning to the enrollment review after Touch ID"
    case sign = "proving possession of this Mac’s protected key"
    case approveServer = "sending approval to the server Mac"
    case waitServer = "waiting for the server Mac’s approval"
    case commit = "saving and verifying the enrollment"

    func failure(_ error: Error) -> JosiError {
        if self == .commit {
            return JosiError(message: "The saved enrollment could not be confirmed. Use Refresh Saved Devices before starting another enrollment; it may already be saved.")
        }
        if error is CancellationError {
            return JosiError(message: "Enrollment was cancelled.")
        }
        var detail = ""
        var status = 0
        if let server = error as? JosiError, server.status != 0 {
            status = server.status
            detail = String(server.message.prefix(600))
            if self == .prepare && server.status == 401 {
                detail += " Use your Josi sign-in password and, only if enabled, a fresh authenticator code. The enrollment review has not opened yet."
            }
        }
        if detail.isEmpty {
            switch self {
            case .createKey: detail = "The protected key helper did not return a verified key. Touch ID alone does not complete enrollment."
            case .connectReview: detail = "The app could not open and verify the server Mac’s local review connection."
            case .review: detail = "The review was cancelled, expired or could not remain open."
            case .authenticate, .sign: detail = "The protected key helper could not complete this exact Touch ID approval."
            case .returnToReview: detail = "The review was closed or expired before Josi returned to the foreground."
            case .approveServer, .waitServer: detail = "The server Mac’s local approval was not confirmed before the request ended."
            default: detail = "This step could not be confirmed. Check the server connection and current Vault status."
            }
        }
        return JosiError(message: "Enrollment stopped while \(rawValue). \(detail)", status: status)
    }
}
