import Foundation

/// A bundle-id list always lags reality: a password manager we have never
/// heard of ships tomorrow, and `AppExclusions` does not know about it. The
/// secure-field subrole only protects the literal masked input, so in any
/// manager we do not exclude the *ordinary* fields are still fair game — an
/// item's notes, a custom field holding a secret, a TOTP seed box, a vault
/// search field echoing a saved username. A burst in one of those would be
/// read and POSTed to the local API.
///
/// This is the second, id-independent guard: refuse a field whose own labels
/// suggest it holds a secret, in any app, and refuse any field inside a
/// window whose title says the same. It is deliberately a *refusal* heuristic
/// — a false positive costs one uncorrected sentence, a false negative sends
/// a secret over the wire — but it still has to leave ordinary writing alone,
/// so matching is on whole words, never substrings. "Notes" is not "note
/// your password", and "shipping" must never match "pin".
public enum SecretFieldHeuristic {
    /// The labels Accessibility gives us for a field and the window it lives
    /// in. All optional: most apps fill in only one or two.
    public struct FieldHints: Equatable, Sendable {
        public var identifier: String?
        public var placeholder: String?
        public var title: String?
        public var roleDescription: String?
        public var help: String?
        public var description: String?
        public var windowTitle: String?

        public init(identifier: String? = nil, placeholder: String? = nil, title: String? = nil,
                    roleDescription: String? = nil, help: String? = nil, description: String? = nil,
                    windowTitle: String? = nil) {
            self.identifier = identifier
            self.placeholder = placeholder
            self.title = title
            self.roleDescription = roleDescription
            self.help = help
            self.description = description
            self.windowTitle = windowTitle
        }

        var all: [String?] { [identifier, placeholder, title, roleDescription, help, description, windowTitle] }
    }

    /// Terms that mark a field as holding a secret. Each is matched as a
    /// contiguous run of whole words, so "api key" matches `apiKey`,
    /// `api_key` and "API Key" but never "apikeyboard".
    public static let vocabulary: [String] = [
        "password", "passwords", "passphrase", "passcode",
        "secret", "secrets", "token", "api key", "apikey", "access key",
        "private key", "secret key", "signing key", "license key",
        "seed", "seed phrase", "mnemonic", "recovery", "recovery code",
        "pin", "pin code", "cvv", "cvc", "security code", "verification code",
        "otp", "totp", "one time code", "one time password", "2fa", "mfa",
        "credential", "credentials", "keychain", "vault",
        "card number", "account number", "routing number", "social security",
    ]

    /// The term that made the field look like a secret, or nil when nothing
    /// matched. Returning the term (rather than a bool) lets the caller say
    /// *why* it skipped in the log.
    public static func match(_ hints: FieldHints) -> String? {
        for hint in hints.all {
            if let term = match(text: hint) { return term }
        }
        return nil
    }

    /// The term matched in a single label, or nil.
    public static func match(text: String?) -> String? {
        guard let text, !text.isEmpty else { return nil }
        let words = self.words(in: text)
        guard !words.isEmpty else { return nil }
        for term in vocabulary {
            let termWords = self.words(in: term)
            guard !termWords.isEmpty else { continue }
            if contains(words, termWords) { return term }
        }
        return nil
    }

    /// True when `needle` appears in `haystack` as a contiguous run.
    private static func contains(_ haystack: [String], _ needle: [String]) -> Bool {
        guard needle.count <= haystack.count else { return false }
        for start in 0...(haystack.count - needle.count) {
            var matched = true
            for offset in needle.indices where haystack[start + offset] != needle[offset] {
                matched = false
                break
            }
            if matched { return true }
        }
        return false
    }

    /// Splits a label into lowercased words, breaking on anything that is not
    /// a letter or a digit and on camel-case humps, so an accessibility
    /// identifier like `totpSeedField` or `api_key` becomes real words. A
    /// trailing "s" is dropped from longer words so "Passwords" matches
    /// "password" without "pins" having to be listed separately.
    static func words(in text: String) -> [String] {
        var words: [String] = []
        var current = ""
        var previous: Character?

        func flush() {
            guard !current.isEmpty else { return }
            words.append(singular(current.lowercased()))
            current = ""
        }

        let characters = Array(text)
        for (index, character) in characters.enumerated() {
            guard character.isLetter || character.isNumber else {
                flush()
                previous = nil
                continue
            }
            if let previous {
                // Digit/letter boundaries, both ways. This has to be
                // symmetric or a hint and the term it should match tokenize
                // differently: "2FA" would be 2|FA while the term "2fa"
                // stayed one word, and the guard would miss it.
                if character.isNumber != previous.isNumber {
                    flush()
                } else if character.isUppercase {
                    // camelCase / PascalCase / acronym boundaries:
                    // "apiKey" -> api|Key, "APIKey" -> API|Key.
                    let next = index + 1 < characters.count ? characters[index + 1] : nil
                    if previous.isLowercase || (previous.isUppercase && (next?.isLowercase ?? false)) {
                        flush()
                    }
                }
            }
            current.append(character)
            previous = character
        }
        flush()
        return words
    }

    /// Crude but predictable singularization: only a trailing "s" on a word
    /// long enough that dropping it cannot turn a real word into a term
    /// ("pins" -> "pin", but "is" is left alone).
    private static func singular(_ word: String) -> String {
        guard word.count > 3, word.hasSuffix("s"), !word.hasSuffix("ss") else { return word }
        return String(word.dropLast())
    }
}
