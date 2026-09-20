import Foundation

/// A span of text that arrived in the focused field in one "burst": what a
/// dictation tool inserted, as opposed to what the user typed key by key.
/// `range` is in UTF-16 units of `fullText` (the unit Accessibility ranges use).
public struct Burst: Equatable, Sendable {
    public let range: NSRange
    public let text: String
    /// The whole field value the burst was cut from, so the engine can refuse
    /// to rewrite when the field moved on before the API answered.
    public let fullText: String

    public init(range: NSRange, text: String, fullText: String) {
        self.range = range
        self.text = text
        self.fullText = fullText
    }
}

/// UTF-16 diff helpers shared by the detector and the splice math.
public enum TextDiff {
    /// The span of `new` that is not shared with `old`: the common prefix and
    /// suffix (in UTF-16 units, never overlapping) are stripped and what
    /// remains is the insertion. `removed` is the corresponding span of `old`.
    public struct Delta: Equatable, Sendable {
        public let location: Int
        public let inserted: Int
        public let removed: Int
        public var insertedRange: NSRange { NSRange(location: location, length: inserted) }
    }

    public static func delta(from old: String, to new: String) -> Delta {
        let a = Array(old.utf16)
        let b = Array(new.utf16)
        var prefix = 0
        let maxPrefix = min(a.count, b.count)
        while prefix < maxPrefix, a[prefix] == b[prefix] { prefix += 1 }
        var suffix = 0
        let maxSuffix = maxPrefix - prefix
        while suffix < maxSuffix, a[a.count - 1 - suffix] == b[b.count - 1 - suffix] { suffix += 1 }
        return Delta(location: prefix, inserted: b.count - prefix - suffix, removed: a.count - prefix - suffix)
    }

    /// Substring of `text` by UTF-16 range; nil when the range does not fit.
    public static func substring(_ text: String, utf16 range: NSRange) -> String? {
        guard range.location >= 0, range.length >= 0, range.location + range.length <= text.utf16.count else { return nil }
        let utf16 = text.utf16
        let start = utf16.index(utf16.startIndex, offsetBy: range.location)
        let end = utf16.index(start, offsetBy: range.length)
        return String(utf16[start..<end])
    }

    /// Replaces the UTF-16 `range` of `text` with `replacement`; nil when the
    /// range does not fit (the caller must then leave the field alone).
    public static func splice(_ text: String, utf16 range: NSRange, with replacement: String) -> String? {
        guard range.location >= 0, range.length >= 0, range.location + range.length <= text.utf16.count else { return nil }
        let utf16 = text.utf16
        let start = utf16.index(utf16.startIndex, offsetBy: range.location)
        let end = utf16.index(start, offsetBy: range.length)
        var units = Array(utf16[..<start])
        units.append(contentsOf: replacement.utf16)
        units.append(contentsOf: utf16[end...])
        return String(decoding: units, as: UTF16.self)
    }

    public static func wordCount(_ text: String) -> Int {
        text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count
    }
}

/// Turns a stream of field-value snapshots into bursts. Pure and clock-free:
/// the caller feeds `record(text:at:)` on every value change and asks
/// `settle(at:)` once it has been quiet for a while.
///
/// One detector per focused element. `lastStable` is the text the field held
/// after the previous decision (fired, skipped or the engine's own rewrite),
/// so the engine's rewrite never re-triggers and typed text that was skipped
/// once is not counted again.
///
/// A burst fires when the field has been quiet for `settleMs` and the text
/// inserted since `lastStable`:
///  - contains at least `minWords` words, or arrived in at most three change
///    events with at least 12 UTF-16 units; and
///  - contains at least one change event that inserted `minChunk` units at
///    once (dictation lands as words or phrases; typing lands one unit at a
///    time, so key-by-key typing never fires); and
///  - is not multi-paragraph (a newline followed by more text) and the field
///    is not longer than `maxFieldLength`.
public final class BurstDetector {
    public struct Config: Equatable, Sendable {
        public var settleMs: Int
        public var minWords: Int
        /// Bursts that arrived in <= `fewEvents` events fire at `fewEventsMinChars` units even if short on words.
        public var fewEvents: Int
        public var fewEventsMinChars: Int
        /// At least one event must insert this many units at once.
        public var minChunk: Int
        public var maxFieldLength: Int

        public init(settleMs: Int = 700, minWords: Int = 3, fewEvents: Int = 3, fewEventsMinChars: Int = 12,
                    minChunk: Int = 4, maxFieldLength: Int = 20_000) {
            self.settleMs = settleMs
            self.minWords = minWords
            self.fewEvents = fewEvents
            self.fewEventsMinChars = fewEventsMinChars
            self.minChunk = minChunk
            self.maxFieldLength = maxFieldLength
        }

        public static let `default` = Config()
    }

    public enum Outcome: Equatable, Sendable {
        /// Nothing pending, or not quiet long enough yet.
        case waiting
        /// Pending changes were examined and dismissed; `lastStable` advanced.
        case skipped(String)
        case burst(Burst)
    }

    public var config: Config
    public private(set) var lastStable: String
    public private(set) var latest: String
    private var lastChangeAt: TimeInterval?
    private var eventCount = 0
    private var maxChunk = 0

    public init(initialText: String, config: Config = .default) {
        self.config = config
        self.lastStable = initialText
        self.latest = initialText
    }

    public var hasPendingChanges: Bool { lastChangeAt != nil }

    /// Feed the field's current value. Identical values are ignored.
    public func record(text: String, at time: TimeInterval) {
        guard text != latest else { return }
        let step = TextDiff.delta(from: latest, to: text)
        latest = text
        if lastChangeAt == nil {
            eventCount = 0
            maxChunk = 0
        }
        eventCount += 1
        maxChunk = max(maxChunk, step.inserted)
        lastChangeAt = time
        if text == lastStable {
            // Back where we started (undo, or a rewrite landing): nothing pending.
            clearPending()
        }
    }

    /// The engine rewrote the field itself: treat `text` as settled.
    public func markStable(_ text: String) {
        lastStable = text
        latest = text
        clearPending()
    }

    /// Ask whether the pending changes form a burst. Call after `settleMs`
    /// of quiet; it is safe to call more often.
    public func settle(at time: TimeInterval) -> Outcome {
        guard let lastChangeAt else { return .waiting }
        guard (time - lastChangeAt) * 1000 >= Double(config.settleMs) - 0.5 else { return .waiting }
        let text = latest
        let delta = TextDiff.delta(from: lastStable, to: text)
        let events = eventCount
        let chunk = maxChunk
        // Whatever we decide, this is the new baseline.
        lastStable = text
        clearPending()

        guard delta.inserted > 0 else { return .skipped("nothing inserted") }
        guard text.utf16.count <= config.maxFieldLength else { return .skipped("field longer than \(config.maxFieldLength)") }
        guard var inserted = TextDiff.substring(text, utf16: delta.insertedRange) else { return .skipped("range out of bounds") }
        // A trailing newline (dictation ending with "new line", or Return) stays
        // out of the burst so the rewrite never has to re-insert one.
        var range = delta.insertedRange
        while let last = inserted.unicodeScalars.last, last == "\n" || last == "\r" {
            inserted.unicodeScalars.removeLast()
            range.length -= 1
        }
        guard range.length > 0 else { return .skipped("nothing inserted") }
        guard chunk >= config.minChunk else { return .skipped("typed, not dictated") }
        let words = TextDiff.wordCount(inserted)
        let enough = words >= config.minWords || (events <= config.fewEvents && inserted.utf16.count >= config.fewEventsMinChars)
        guard enough else { return .skipped("too short (\(words) words, \(inserted.utf16.count) units)") }
        guard !BurstDetector.isMultiParagraph(inserted) else { return .skipped("multi-paragraph") }
        return .burst(Burst(range: range, text: inserted, fullText: text))
    }

    /// A newline followed by more (non-whitespace) text. A trailing newline is fine.
    public static func isMultiParagraph(_ text: String) -> Bool {
        guard let newline = text.firstIndex(where: { $0.isNewline }) else { return false }
        let rest = text[text.index(after: newline)...]
        return rest.contains(where: { !$0.isWhitespace })
    }

    private func clearPending() {
        lastChangeAt = nil
        eventCount = 0
        maxChunk = 0
    }
}
