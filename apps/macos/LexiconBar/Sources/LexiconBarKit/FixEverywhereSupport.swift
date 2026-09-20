import Foundation

/// Which apps "Fix everywhere" stays out of. Terminals (a rewrite in a shell
/// is a command, not a sentence) and password managers are excluded by
/// default; the user can add or remove ids. Entries match a bundle id
/// case-insensitively; a trailing `.*` matches a prefix (`com.jetbrains.*`).
public struct AppExclusions: Equatable, Sendable {
    public static let defaults: [String] = [
        "com.apple.Terminal",
        "com.googlecode.iterm2",
        "dev.warp.Warp-Stable",
        "com.apple.Passwords",
        "com.1password.1password",
        "com.agilebits.onepassword7",
        "com.apple.keychainaccess",
    ]

    public var bundleIDs: [String]

    public init(bundleIDs: [String] = AppExclusions.defaults) {
        self.bundleIDs = bundleIDs
    }

    public func isExcluded(_ bundleID: String?) -> Bool {
        guard let bundleID, !bundleID.isEmpty else { return false }
        let id = bundleID.lowercased()
        for entry in bundleIDs {
            let pattern = entry.trimmingCharacters(in: .whitespaces).lowercased()
            if pattern.isEmpty { continue }
            if pattern.hasSuffix(".*") {
                if id.hasPrefix(String(pattern.dropLast(1))) { return true }
            } else if pattern == id {
                return true
            }
        }
        return false
    }

    /// Adds `bundleID` (exact, no wildcard) if not already matched.
    public mutating func exclude(_ bundleID: String) {
        let id = bundleID.trimmingCharacters(in: .whitespaces)
        guard !id.isEmpty, !isExcluded(id) else { return }
        bundleIDs.append(id)
    }

    /// Removes every entry that matches `bundleID` (exact entries and wildcards alike).
    public mutating func include(_ bundleID: String) {
        let id = bundleID.lowercased()
        bundleIDs.removeAll { entry in
            let pattern = entry.trimmingCharacters(in: .whitespaces).lowercased()
            if pattern.hasSuffix(".*") { return id.hasPrefix(String(pattern.dropLast(1))) }
            return pattern == id
        }
    }
}

/// One replacement the API reported, positioned in the burst text (UTF-16).
public struct FixReplacement: Equatable, Sendable {
    public let start: Int
    public let end: Int
    public let original: String
    public let replacement: String
    public let reason: String?
    public let confidence: Double?

    public init(start: Int, end: Int, original: String, replacement: String, reason: String? = nil, confidence: Double? = nil) {
        self.start = start
        self.end = end
        self.original = original
        self.replacement = replacement
        self.reason = reason
        self.confidence = confidence
    }

    public var asReplacement: Replacement { Replacement(original: original, replacement: replacement, reason: reason, confidence: confidence) }
}

/// The parsed body of `POST /normalize`.
public struct NormalizeResponse: Equatable, Sendable {
    public let input: String
    public let output: String
    public let changed: Bool
    public let replacements: [FixReplacement]
    public let summary: String

    public init(input: String, output: String, changed: Bool, replacements: [FixReplacement], summary: String) {
        self.input = input
        self.output = output
        self.changed = changed
        self.replacements = replacements
        self.summary = summary
    }

    public static func parse(_ data: Data) -> NormalizeResponse? {
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let output = object["output"] as? String else { return nil }
        let input = object["input"] as? String ?? ""
        var replacements: [FixReplacement] = []
        for item in (object["replacements"] as? [[String: Any]]) ?? [] {
            guard let original = item["original"] as? String else { continue }
            let replacement = (item["replacement"] as? String) ?? (item["canonical"] as? String) ?? original
            replacements.append(FixReplacement(
                start: CLIOutput.number(item["start"]).map(Int.init) ?? 0,
                end: CLIOutput.number(item["end"]).map(Int.init) ?? 0,
                original: original,
                replacement: replacement,
                reason: item["reason"] as? String,
                confidence: CLIOutput.number(item["confidence"])
            ))
        }
        let changed = (object["changed"] as? Bool) ?? (output != input)
        let summary = (object["summary"] as? String) ?? CLIOutput.defaultSummary(count: replacements.count)
        return NormalizeResponse(input: input, output: output, changed: changed, replacements: replacements, summary: summary)
    }
}

/// The safety checks between "the API changed the burst" and "write it into
/// the field", and the resulting write plan. Pure so it is testable.
public enum RewritePlan {
    public struct Plan: Equatable, Sendable {
        /// Range of the burst inside the field, UTF-16.
        public let range: NSRange
        public let previousText: String
        public let newText: String
        /// Whole field value after the splice (for the AXValue fallback and verification).
        public let splicedFullText: String
        /// Where the caret goes afterwards: end of the replaced span.
        public var caret: NSRange { NSRange(location: range.location + newText.utf16.count, length: 0) }

        public init(range: NSRange, previousText: String, newText: String, splicedFullText: String) {
            self.range = range
            self.previousText = previousText
            self.newText = newText
            self.splicedFullText = splicedFullText
        }
    }

    public enum Refusal: Error, Equatable, Sendable {
        case unchanged
        case fieldChanged
        case fieldTooLong
        case multiParagraph
        case replacementOutsideBurst
        case rangeOutOfBounds
    }

    public static func make(burst: Burst, response: NormalizeResponse, currentFieldText: String,
                            maxFieldLength: Int = 20_000) -> Result<Plan, Refusal> {
        guard response.changed, response.output != burst.text else { return .failure(.unchanged) }
        guard currentFieldText == burst.fullText else { return .failure(.fieldChanged) }
        guard currentFieldText.utf16.count <= maxFieldLength else { return .failure(.fieldTooLong) }
        guard !BurstDetector.isMultiParagraph(burst.text) else { return .failure(.multiParagraph) }
        // A newline the burst did not have would be typed as Return in the
        // keystroke strategy, which sends a chat message; never allow it.
        if response.output.contains(where: { $0.isNewline }), !burst.text.contains(where: { $0.isNewline }) {
            return .failure(.multiParagraph)
        }
        let burstLength = burst.text.utf16.count
        for r in response.replacements where r.start < 0 || r.end > burstLength || r.end < r.start {
            return .failure(.replacementOutsideBurst)
        }
        guard TextDiff.substring(currentFieldText, utf16: burst.range) == burst.text,
              let spliced = TextDiff.splice(currentFieldText, utf16: burst.range, with: response.output) else {
            return .failure(.rangeOutOfBounds)
        }
        return .success(Plan(range: burst.range, previousText: burst.text, newText: response.output, splicedFullText: spliced))
    }
}

/// Remembers the last rewrite so ⌃⌥Z can put the original text back, but
/// only while the same field still holds exactly the corrected text.
public struct UndoLedger: Equatable, Sendable {
    public struct Entry: Equatable, Sendable {
        /// Opaque identity of the field (the app decides what it is).
        public let fieldKey: String
        public let range: NSRange
        public let correctedText: String
        public let previousText: String
        /// Field value right after the rewrite.
        public let fieldTextAfter: String

        public init(fieldKey: String, range: NSRange, correctedText: String, previousText: String, fieldTextAfter: String) {
            self.fieldKey = fieldKey
            self.range = range
            self.correctedText = correctedText
            self.previousText = previousText
            self.fieldTextAfter = fieldTextAfter
        }

        /// The field value after undoing, when the field still holds the corrected text.
        public var fieldTextBefore: String? {
            TextDiff.splice(fieldTextAfter, utf16: NSRange(location: range.location, length: correctedText.utf16.count), with: previousText)
        }
    }

    public private(set) var last: Entry?

    public init() {}

    public mutating func record(_ entry: Entry) { last = entry }

    /// True when `fieldKey`/`currentText` still match the last rewrite.
    public func canUndo(fieldKey: String, currentText: String) -> Bool {
        guard let last else { return false }
        return last.fieldKey == fieldKey && last.fieldTextAfter == currentText
    }

    /// Consumes the entry if it still applies; nil otherwise.
    public mutating func take(fieldKey: String, currentText: String) -> Entry? {
        guard canUndo(fieldKey: fieldKey, currentText: currentText), let entry = last else { return nil }
        last = nil
        return entry
    }

    public mutating func clear() { last = nil }
}
