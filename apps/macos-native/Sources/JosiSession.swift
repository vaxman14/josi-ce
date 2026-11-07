import Foundation
import Security

/// The kept sign-in for "Keep me signed in", one per server, in the login
/// Keychain. Nothing else about a session is written to disk.
enum JosiSession {
    private static let service = "com.heyjosi.josi.session"
    private static func query(_ server: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
         kSecAttrAccount as String: server.trimmingCharacters(in: CharacterSet(charactersIn: "/"))]
    }
    static func token(for server: String) -> String? {
        var item: CFTypeRef?
        var search = query(server); search[kSecReturnData as String] = true
        guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static func keep(_ token: String, for server: String) {
        forget(server)
        var item = query(server)
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlocked
        SecItemAdd(item as CFDictionary, nil)
    }
    static func forget(_ server: String) { SecItemDelete(query(server) as CFDictionary) }
}
