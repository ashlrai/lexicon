import XCTest
@testable import LexiconBarKit

final class BurstDetectorTests: XCTestCase {
    private let settle = 0.7
    /// Silence that ends a streamed run (`Config.runQuietMs`).
    private let runQuiet = 1.5

    /// Types `text` one character at a time, `gap` seconds apart, starting at `t`.
    private func type(_ text: String, into d: BurstDetector, base: String, from t: TimeInterval, gap: TimeInterval = 0.08) -> TimeInterval {
        var now = t
        var current = base
        for ch in text {
            current.append(ch)
            d.record(text: current, at: now)
            now += gap
        }
        return now
    }

    func testCharAtATimeTypingNeverFires() {
        let d = BurstDetector(initialText: "")
        let end = type("ping ashler about the cooper netties rollout", into: d, base: "", from: 0)
        XCTAssertEqual(d.settle(at: end + settle), .skipped("typed, not dictated"))
        XCTAssertEqual(d.lastStable, "ping ashler about the cooper netties rollout")
        // And a later poll finds nothing pending.
        XCTAssertEqual(d.settle(at: end + 5), .waiting)
    }

    func testFiveWordInsertionFiresAfterSettle() {
        let d = BurstDetector(initialText: "Hi. ")
        d.record(text: "Hi. ping ashler about the rollout", at: 1.0)
        XCTAssertEqual(d.settle(at: 1.3), .waiting, "not quiet long enough")
        guard case .burst(let burst) = d.settle(at: 1.0 + settle) else { return XCTFail("expected a burst") }
        XCTAssertEqual(burst.text, "ping ashler about the rollout")
        XCTAssertEqual(burst.range, NSRange(location: 4, length: 29))
        XCTAssertEqual(burst.fullText, "Hi. ping ashler about the rollout")
        XCTAssertEqual(d.settle(at: 3), .waiting)
    }

    func testPhraseByPhraseDictationFires() {
        // macOS dictation inserts words/phrases as they are recognised.
        let d = BurstDetector(initialText: "")
        d.record(text: "ping ", at: 0)
        d.record(text: "ping ashler ", at: 0.2)
        d.record(text: "ping ashler about the ", at: 0.4)
        d.record(text: "ping ashler about the cooper netties rollout", at: 0.6)
        XCTAssertEqual(d.settle(at: 0.9), .waiting)
        // A run that arrived as several insertions may still have words
        // coming, so settleMs of quiet is no longer enough to end it.
        XCTAssertEqual(d.settle(at: 0.6 + settle), .coalescing)
        XCTAssertEqual(d.lastStable, "", "a coalescing run must not move the baseline")
        guard case .burst(let burst) = d.settle(at: 0.6 + runQuiet) else { return XCTFail("expected a burst") }
        XCTAssertEqual(burst.range, NSRange(location: 0, length: 44))
    }

    func testShortSingleEventFiresAtTwelveChars() {
        let d = BurstDetector(initialText: "Deploy to ")
        d.record(text: "Deploy to cooper netties", at: 0)
        guard case .burst(let burst) = d.settle(at: settle) else { return XCTFail("expected a burst") }
        XCTAssertEqual(burst.text, "cooper netties")

        let short = BurstDetector(initialText: "")
        short.record(text: "ashler", at: 0)
        // One word-sized insertion could be the first word of a dictated
        // phrase, so it is held until the silence says otherwise.
        XCTAssertEqual(short.settle(at: settle), .coalescing)
        XCTAssertEqual(short.settle(at: runQuiet), .skipped("too short (1 words, 6 units)"))
    }

    func testOwnRewriteDoesNotRetrigger() {
        let d = BurstDetector(initialText: "")
        d.record(text: "ping ashler about the rollout", at: 0)
        guard case .burst = d.settle(at: settle) else { return XCTFail("expected a burst") }
        // The engine rewrites the field; the app sees a value change with the new text.
        d.markStable("ping Ashlr.AI about the rollout")
        d.record(text: "ping Ashlr.AI about the rollout", at: 1.0)
        XCTAssertFalse(d.hasPendingChanges)
        XCTAssertEqual(d.settle(at: 1.0 + settle), .waiting)
        // Even without markStable, a value-changed event that lands on lastStable is inert.
        d.record(text: "ping Ashlr.AI about the rollout", at: 2.0)
        XCTAssertEqual(d.settle(at: 3.0), .waiting)
    }

    func testMultiParagraphGuard() {
        let d = BurstDetector(initialText: "")
        d.record(text: "first line about ashler\nsecond line about versel", at: 0)
        XCTAssertEqual(d.settle(at: settle), .skipped("multi-paragraph"))
        XCTAssertEqual(d.lastStable, "first line about ashler\nsecond line about versel")

        let trailing = BurstDetector(initialText: "")
        trailing.record(text: "ping ashler about the rollout\n", at: 0)
        guard case .burst(let b) = trailing.settle(at: settle) else { return XCTFail("a trailing newline is fine") }
        XCTAssertEqual(b.text, "ping ashler about the rollout", "the newline stays out of the burst")
        XCTAssertEqual(b.range, NSRange(location: 0, length: 29))
        let onlyNewline = BurstDetector(initialText: "abc")
        onlyNewline.record(text: "abc\n\n\n\n", at: 0)
        XCTAssertEqual(onlyNewline.settle(at: settle), .skipped("nothing inserted"))
        XCTAssertTrue(BurstDetector.isMultiParagraph("a\nb"))
        XCTAssertFalse(BurstDetector.isMultiParagraph("a\n  \n"))
    }

    func testUTF16RangeMathWithEmoji() {
        let base = "Team \u{1F680} update: "        // rocket is 2 UTF-16 units
        let inserted = "tell mason white about versel \u{1F44D}"
        let d = BurstDetector(initialText: base)
        d.record(text: base + inserted, at: 0)
        guard case .burst(let burst) = d.settle(at: settle) else { return XCTFail("expected a burst") }
        XCTAssertEqual(burst.range.location, base.utf16.count)
        XCTAssertEqual(burst.range.length, inserted.utf16.count)
        XCTAssertEqual(burst.text, inserted)
        XCTAssertEqual(TextDiff.substring(base + inserted, utf16: burst.range), inserted)
        // Insertion in the middle, between two emoji.
        let mid = "\u{1F600}\u{1F601}"
        let d2 = BurstDetector(initialText: mid)
        d2.record(text: "\u{1F600}ping ashler about the rollout\u{1F601}", at: 0)
        guard case .burst(let b2) = d2.settle(at: settle) else { return XCTFail("expected a burst") }
        XCTAssertEqual(b2.range, NSRange(location: 2, length: 29))
        XCTAssertEqual(b2.text, "ping ashler about the rollout")
    }

    func testFieldTooLongIsSkipped() {
        let d = BurstDetector(initialText: "", config: .init(maxFieldLength: 30))
        d.record(text: String(repeating: "word ", count: 10), at: 0)
        XCTAssertEqual(d.settle(at: settle), .skipped("field longer than 30"))
    }

    func testDeletionAndReplacementDoNotFire() {
        let d = BurstDetector(initialText: "ping ashler about the rollout")
        d.record(text: "ping about the rollout", at: 0)
        XCTAssertEqual(d.settle(at: settle), .skipped("nothing inserted"))
        // Selecting a word and dictating a single short word over it is too short.
        d.record(text: "ping Ashlr about the rollout", at: 1)
        XCTAssertEqual(d.settle(at: 1 + settle), .coalescing)
        XCTAssertEqual(d.settle(at: 1 + runQuiet), .skipped("too short (1 words, 6 units)"))
    }

    func testSettleHonoursConfiguredDelayAndMinWords() {
        let d = BurstDetector(initialText: "", config: .init(settleMs: 1200, minWords: 5, fewEventsMinChars: 100))
        d.record(text: "ping ashler about the", at: 0)
        XCTAssertEqual(d.settle(at: 0.8), .waiting)
        XCTAssertEqual(d.settle(at: 1.2), .coalescing)
        XCTAssertEqual(d.settle(at: runQuiet), .skipped("too short (4 words, 21 units)"))
        d.record(text: "ping ashler about the cooper netties rollout", at: 2)
        // Diff against the new baseline: only " cooper netties rollout" is new (3 words), below minWords 5.
        XCTAssertEqual(d.settle(at: 3.2), .coalescing)
        XCTAssertEqual(d.settle(at: 2 + runQuiet), .skipped("too short (3 words, 23 units)"))
    }

    // MARK: streamed dictation
    //
    // macOS dictation, Wispr Flow's streaming mode and an app's own microphone
    // button all insert a word at a time rather than pasting a finished
    // phrase, and the gaps between spoken words are routinely longer than
    // settleMs. Deciding at the first gap chopped such a phrase into single
    // words, each "too short", so the whole sentence went uncorrected.

    func testStreamedDictationWithPausesLongerThanSettleCoalescesIntoOneBurst() {
        let d = BurstDetector(initialText: "")
        var now = 0.0
        var text = ""
        for word in ["ping ", "ashler ", "about ", "the ", "cuban ", "eats ", "rollout"] {
            text += word
            d.record(text: text, at: now)
            // The engine asks again settleMs after each word; the run has to
            // stay pending or the word is dropped on its own.
            XCTAssertEqual(d.settle(at: now + settle, caretEnd: text.utf16.count), .coalescing,
                           "run ended early at \"\(word)\"")
            now += 0.9
        }
        let lastWordAt = now - 0.9
        guard case .burst(let burst) = d.settle(at: now + runQuiet, caretEnd: text.utf16.count) else {
            return XCTFail("expected the whole phrase as one burst")
        }
        XCTAssertEqual(burst.text, "ping ashler about the cuban eats rollout")
        XCTAssertEqual(burst.range, NSRange(location: 0, length: 40))
        XCTAssertEqual(d.settle(at: lastWordAt + 5, caretEnd: text.utf16.count), .waiting)
    }

    func testTypingThenPauseThenDictationCorrectsOnlyTheDictation() {
        let d = BurstDetector(initialText: "")
        // Typed by hand, character at a time: still refused.
        var now = type("Meeting notes. ", into: d, base: "", from: 0)
        XCTAssertEqual(d.settle(at: now + settle), .skipped("typed, not dictated"))
        XCTAssertEqual(d.lastStable, "Meeting notes. ")

        // Then the user pauses and dictates. The burst is the dictated span
        // only — the typed prefix is already the baseline.
        var text = "Meeting notes. "
        now += 2
        for word in ["ping ", "ashler ", "about ", "the ", "rollout"] {
            text += word
            d.record(text: text, at: now)
            XCTAssertEqual(d.settle(at: now + settle, caretEnd: text.utf16.count), .coalescing)
            now += 0.9
        }
        guard case .burst(let burst) = d.settle(at: now + runQuiet, caretEnd: text.utf16.count) else {
            return XCTFail("expected a burst")
        }
        XCTAssertEqual(burst.text, "ping ashler about the rollout")
        XCTAssertEqual(burst.range, NSRange(location: 15, length: 29))
    }

    func testSlowTypingIsNeverCoalescedIntoABurst() {
        // The guard that keeps the coalescing window from swallowing ordinary
        // typing is chunk size, not rate: typing one character at a time never
        // produces a minChunk-sized insertion, however long the pauses are.
        let d = BurstDetector(initialText: "")
        let end = type("ping ashler about the cuban eats rollout", into: d, base: "", from: 0, gap: 0.9)
        XCTAssertEqual(d.settle(at: end + settle), .skipped("typed, not dictated"))
        XCTAssertEqual(d.settle(at: end + 10), .waiting)
    }

    func testAPasteStillFiresAtSettleWithoutWaitingForTheRunWindow() {
        // One insertion that already reads as a burst has nothing to wait for;
        // holding it would add a second of latency to every paste.
        let d = BurstDetector(initialText: "")
        d.record(text: "ping ashler about the cuban eats rollout", at: 0)
        guard case .burst = d.settle(at: settle) else { return XCTFail("a paste must fire at settleMs") }
    }

    func testACoalescingRunIsCappedByMaxRunMs() {
        // Continuous dictation must still be corrected periodically rather
        // than held forever waiting for a silence that never comes.
        let d = BurstDetector(initialText: "", config: .init(maxRunMs: 3000))
        var now = 0.0
        var text = ""
        for word in ["ping ", "ashler ", "about ", "the ", "rollout "] {
            text += word
            d.record(text: text, at: now)
            now += 0.9
        }
        guard case .burst = d.settle(at: now) else { return XCTFail("expected the capped run to fire") }
    }

    func testHardRefusalsAreNotHeldOpen() {
        // Silence cannot turn a multi-paragraph insertion into a single one,
        // so it is refused at settleMs rather than after the run window.
        let d = BurstDetector(initialText: "")
        d.record(text: "first line about ashler\nsecond line", at: 0)
        XCTAssertEqual(d.settle(at: settle), .skipped("multi-paragraph"))
    }

    func testTextDiffDelta() {
        XCTAssertEqual(TextDiff.delta(from: "abc", to: "abXYc"), .init(location: 2, inserted: 2, removed: 0))
        XCTAssertEqual(TextDiff.delta(from: "abc", to: "abc"), .init(location: 3, inserted: 0, removed: 0))
        XCTAssertEqual(TextDiff.delta(from: "", to: "abc"), .init(location: 0, inserted: 3, removed: 0))
        // One more "a" could have been inserted at any of the four positions;
        // the window is reported with the play that makes it a guess.
        XCTAssertEqual(TextDiff.delta(from: "aaa", to: "aaaa"),
                       .init(location: 3, inserted: 1, removed: 0, slideLeft: 3, slideRight: 0))
        XCTAssertEqual(TextDiff.delta(from: "abc", to: "aXc"), .init(location: 1, inserted: 1, removed: 1))
        XCTAssertEqual(TextDiff.wordCount("  two   words \n"), 2)
    }
}
