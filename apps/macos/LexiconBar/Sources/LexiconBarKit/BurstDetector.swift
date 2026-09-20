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
    ///
    /// A prefix/suffix diff cannot always say *where* an insertion happened.
    /// Pasting "ping ashler …" in front of a field that already reads
    /// "ping Ashlr.AI …" shares the leading "ping ", so the stripped window
    /// starts five units late and runs five units into the old text — a span
    /// that is textually consistent but is not what was inserted. Rewriting
    /// that window splices the correction into the middle of a word and leaves
    /// the rest of the burst untouched. `slideLeft` / `slideRight` measure how
    /// far the window could move and still produce `new`; `anchored` says the
    /// caret pinned it, so the position is known rather than guessed.
    public struct Delta: Equatable, Sendable {
        public let location: Int
        public let inserted: Int
        public let removed: Int
        /// Play in the insertion point, in UTF-16 units. Zero for a replacement.
        public let slideLeft: Int
        public let slideRight: Int
        /// The caret picked `location` out of the possible positions.
        public let anchored: Bool

        public init(location: Int, inserted: Int, removed: Int,
                    slideLeft: Int = 0, slideRight: Int = 0, anchored: Bool = false) {
            self.location = location
            self.inserted = inserted
            self.removed = removed
            self.slideLeft = slideLeft
            self.slideRight = slideRight
            self.anchored = anchored
        }

        public var insertedRange: NSRange { NSRange(location: location, length: inserted) }

        /// The insertion could have happened somewhere else and nothing pinned
        /// it down. The caller must not rewrite a window it only guessed at.
        public var isAmbiguous: Bool { !anchored && (slideLeft > 0 || slideRight > 0) }
    }

    /// `caretEnd` is the UTF-16 offset the insertion point sits at now. After
    /// a paste or a dictation insert it is the end of what arrived, which is
    /// what resolves an ambiguous window. Pass nil when it is unknown.
    public static func delta(from old: String, to new: String, caretEnd: Int? = nil) -> Delta {
        let a = Array(old.utf16)
        let b = Array(new.utf16)
        var prefix = 0
        let maxPrefix = min(a.count, b.count)
        while prefix < maxPrefix, a[prefix] == b[prefix] { prefix += 1 }
        var suffix = 0
        let maxSuffix = maxPrefix - prefix
        while suffix < maxSuffix, a[a.count - 1 - suffix] == b[b.count - 1 - suffix] { suffix += 1 }
        let location = prefix
        let inserted = b.count - prefix - suffix
        let removed = a.count - prefix - suffix
        guard removed == 0, inserted > 0 else {
            return Delta(location: location, inserted: inserted, removed: removed)
        }

        // How far the window can slide while `new` stays the same: one unit to
        // the left whenever the unit before the window equals the last unit in
        // it, and one to the right whenever the unit after it equals the first.
        var left = 0
        while location - left > 0, b[location - left - 1] == b[location - left + inserted - 1] { left += 1 }
        var right = 0
        while location + inserted + right < b.count, b[location + right] == b[location + inserted + right] { right += 1 }

        if let caretEnd, caretEnd - inserted >= location - left, caretEnd - inserted <= location + right {
            let anchoredLocation = caretEnd - inserted
            let shift = anchoredLocation - location
            return Delta(location: anchoredLocation, inserted: inserted, removed: 0,
                         slideLeft: left + shift, slideRight: right - shift, anchored: true)
        }
        return Delta(location: location, inserted: inserted, removed: 0, slideLeft: left, slideRight: right)
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
        /// Quiet needed to call a *streamed* run finished, as opposed to a
        /// single insertion. Speech pauses are routinely longer than
        /// `settleMs`, so a streamed phrase is only finished after a silence
        /// longer than a pause between words.
        public var runQuietMs: Int
        /// Hard cap on how long one run may go on coalescing, so continuous
        /// dictation is still corrected periodically instead of never.
        public var maxRunMs: Int

        public init(settleMs: Int = 700, minWords: Int = 3, fewEvents: Int = 3, fewEventsMinChars: Int = 12,
                    minChunk: Int = 4, maxFieldLength: Int = 20_000,
                    runQuietMs: Int = 1500, maxRunMs: Int = 12_000) {
            self.settleMs = settleMs
            self.minWords = minWords
            self.fewEvents = fewEvents
            self.fewEventsMinChars = fewEventsMinChars
            self.minChunk = minChunk
            self.maxFieldLength = maxFieldLength
            self.runQuietMs = runQuietMs
            self.maxRunMs = maxRunMs
        }

        public static let `default` = Config()
    }

    public enum Outcome: Equatable, Sendable {
        /// Nothing pending, or not quiet long enough yet.
        case waiting
        /// Dictation is still streaming in: word-sized insertions have been
        /// arriving and the field has not been quiet long enough to call the
        /// phrase finished. Nothing has been decided and `lastStable` has not
        /// moved — ask again shortly.
        case coalescing
        /// Pending changes were examined and dismissed; `lastStable` advanced.
        case skipped(String)
        case burst(Burst)
    }

    public var config: Config
    public private(set) var lastStable: String
    public private(set) var latest: String
    private var lastChangeAt: TimeInterval?
    /// When the first change since `lastStable` arrived, so a coalescing run
    /// can be capped by age as well as by silence.
    private var runStartedAt: TimeInterval?
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
        if lastChangeAt == nil, runStartedAt == nil {
            eventCount = 0
            maxChunk = 0
            runStartedAt = time
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
    ///
    /// `caretEnd` is where the insertion point sits now (UTF-16 offset into
    /// the field). It decides *which* of several textually identical windows
    /// was the one that arrived; without it an ambiguous insertion is skipped
    /// rather than guessed at, because rewriting the wrong window corrupts the
    /// text around it.
    public func settle(at time: TimeInterval, caretEnd: Int? = nil) -> Outcome {
        guard let lastChangeAt else { return .waiting }
        let quietMs = (time - lastChangeAt) * 1000
        guard quietMs >= Double(config.settleMs) - 0.5 else { return .waiting }
        let text = latest
        let delta = TextDiff.delta(from: lastStable, to: text, caretEnd: caretEnd)
        let events = eventCount
        let chunk = maxChunk
        let runAgeMs = runStartedAt.map { (time - $0) * 1000 } ?? 0
        let verdict = evaluate(text: text, delta: delta, events: events, chunk: chunk)

        // Streamed dictation (macOS dictation, Wispr Flow's streaming mode,
        // an app's own microphone button) does not arrive as one insertion.
        // It arrives a word at a time, and the gaps between spoken words are
        // routinely longer than `settleMs` — so deciding at `settleMs` chops
        // the phrase into single words, each of which is "too short" and is
        // dropped. The whole sentence then goes uncorrected, which looks
        // exactly like the feature not working.
        //
        // So: once a run has produced at least one word-sized insertion, keep
        // it pending until the field has been quiet for `runQuietMs` — longer
        // than a pause between words, shorter than the end of a sentence —
        // rather than deciding at the first gap. `lastStable` does not move,
        // so the words accumulate into one burst and are corrected together.
        //
        // Two things keep this from swallowing ordinary typing and pastes:
        // key-by-key typing never produces a `minChunk`-sized insertion, so
        // it is never a run and is still refused with "typed, not dictated";
        // and a single insertion that already reads as a burst is a paste
        // with nothing to wait for, so it fires at `settleMs` as before.
        // Only a verdict that more speech could actually change is worth
        // waiting on. "Too short" can grow into a burst; a burst that arrived
        // as several insertions may still have words coming. A single
        // insertion that already reads as a burst is a paste, with nothing to
        // wait for, so it still fires at `settleMs`. Everything else —
        // multi-paragraph, field too long, key-by-key typing, an insertion
        // point we cannot locate — is refused now, because silence will not
        // make it true.
        let canGrow: Bool
        switch verdict {
        case .burst: canGrow = events > 1
        case .tooShort: canGrow = true
        case .refused: canGrow = false
        }
        if canGrow, quietMs < Double(config.runQuietMs), runAgeMs < Double(config.maxRunMs) {
            return .coalescing
        }

        // Whatever we decide, this is the new baseline.
        lastStable = text
        clearPending()
        switch verdict {
        case .burst(let burst): return .burst(burst)
        case .tooShort(let why), .refused(let why): return .skipped(why)
        }
    }

    /// What `settle` decided, before it decides whether to act on it.
    private enum Verdict {
        case burst(Burst)
        /// Dictation-shaped, but not enough of it yet. More speech changes this.
        case tooShort(String)
        /// No amount of waiting changes this.
        case refused(String)
    }

    /// The burst rules, with no side effects, so `settle` can look at the
    /// answer and still leave the run pending.
    private func evaluate(text: String, delta: TextDiff.Delta, events: Int, chunk: Int) -> Verdict {
        guard delta.inserted > 0 else { return .refused("nothing inserted") }
        guard text.utf16.count <= config.maxFieldLength else { return .refused("field longer than \(config.maxFieldLength)") }
        guard var inserted = TextDiff.substring(text, utf16: delta.insertedRange) else { return .refused("range out of bounds") }
        // A trailing newline (dictation ending with "new line", or Return) stays
        // out of the burst so the rewrite never has to re-insert one.
        var range = delta.insertedRange
        while let last = inserted.unicodeScalars.last, last == "\n" || last == "\r" {
            inserted.unicodeScalars.removeLast()
            range.length -= 1
        }
        guard range.length > 0 else { return .refused("nothing inserted") }
        guard chunk >= config.minChunk else { return .refused("typed, not dictated") }
        let words = TextDiff.wordCount(inserted)
        let enough = words >= config.minWords || (events <= config.fewEvents && inserted.utf16.count >= config.fewEventsMinChars)
        guard enough else { return .tooShort("too short (\(words) words, \(inserted.utf16.count) units)") }
        guard !BurstDetector.isMultiParagraph(inserted) else { return .refused("multi-paragraph") }
        // Last, because it is the only check whose answer is "this really does
        // look like a burst, but we cannot say where it went". Rewriting a
        // window we only guessed at splices the correction into the middle of
        // the user's own words, so there is nothing to do but leave it alone.
        guard !delta.isAmbiguous else {
            return .refused("insertion point is ambiguous (\(delta.slideLeft) left, \(delta.slideRight) right)")
        }
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
        runStartedAt = nil
        eventCount = 0
        maxChunk = 0
    }
}
