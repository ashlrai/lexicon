import XCTest
@testable import LexiconBarKit

final class BurstDetectorTests: XCTestCase {
    private let settle = 0.7

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
        guard case .burst(let burst) = d.settle(at: 0.6 + settle) else { return XCTFail("expected a burst") }
        XCTAssertEqual(burst.range, NSRange(location: 0, length: 44))
    }

    func testShortSingleEventFiresAtTwelveChars() {
        let d = BurstDetector(initialText: "Deploy to ")
        d.record(text: "Deploy to cooper netties", at: 0)
        guard case .burst(let burst) = d.settle(at: settle) else { return XCTFail("expected a burst") }
        XCTAssertEqual(burst.text, "cooper netties")

        let short = BurstDetector(initialText: "")
        short.record(text: "ashler", at: 0)
        XCTAssertEqual(short.settle(at: settle), .skipped("too short (1 words, 6 units)"))
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
        XCTAssertEqual(d.settle(at: 1 + settle), .skipped("too short (1 words, 6 units)"))
    }

    func testSettleHonoursConfiguredDelayAndMinWords() {
        let d = BurstDetector(initialText: "", config: .init(settleMs: 1200, minWords: 5, fewEventsMinChars: 100))
        d.record(text: "ping ashler about the", at: 0)
        XCTAssertEqual(d.settle(at: 0.8), .waiting)
        XCTAssertEqual(d.settle(at: 1.2), .skipped("too short (4 words, 21 units)"))
        d.record(text: "ping ashler about the cooper netties rollout", at: 2)
        // Diff against the new baseline: only " cooper netties rollout" is new (3 words), below minWords 5.
        XCTAssertEqual(d.settle(at: 3.2), .skipped("too short (3 words, 23 units)"))
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
