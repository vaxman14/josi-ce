import Foundation

/// Wire values stay in memory. No server response, login or Vault material is
/// written to preferences, a cookie file, a diagnostic log or a web renderer.
enum Wire: Codable, Sendable, Equatable {
    case object([String: Wire]), array([Wire]), string(String), number(Double), bool(Bool), null
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode([Wire].self) { self = .array(v) }
        else { self = .object(try c.decode([String: Wire].self)) }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .object(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .bool(let v): try c.encode(v)
        case .null: try c.encodeNil()
        }
    }
    subscript(_ key: String) -> Wire { if case .object(let o) = self { return o[key] ?? .null }; return .null }
    var text: String { if case .string(let v) = self { return v }; return "" }
    var list: [Wire] { if case .array(let v) = self { return v }; return [] }
    var flag: Bool { if case .bool(let v) = self { return v }; return false }
    var integer: Int { if case .number(let v) = self, v.isFinite, abs(v) < 9e15 { return Int(v) }; return 0 }
    var identifier: String { self["id"].text.isEmpty ? self["goalId"].text : self["id"].text }
}
extension Wire: ExpressibleByDictionaryLiteral {
    init(dictionaryLiteral elements: (String, Wire)...) { self = .object(Dictionary(uniqueKeysWithValues: elements)) }
}
extension Wire: ExpressibleByStringLiteral {
    init(stringLiteral value: String) { self = .string(value) }
}
struct JosiError: LocalizedError, Sendable {
    let message: String
    var status = 0
    var errorDescription: String? { message }
}
