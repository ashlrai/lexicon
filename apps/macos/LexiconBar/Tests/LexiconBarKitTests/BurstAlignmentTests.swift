import XCTest
@testable import LexiconBarKit

/// Regression tests for the one failure that matters most: a rewrite landing
/// on the wrong span and mangling text the user had already written.
///
/// Seen live in TextEdit. The document held
///   "ping Ashlr.AI about the cooper netties rollout"
/// and a dictation burst, "ping ashler about the cuban eats rollout on versal",
/// arrived in front of it. Both start "ping ", so the prefix/suffix diff
/// attributed those five units to the old text and reported the insertion five
/// units late — a window running from inside the new text into the old. The
/// window was textually consistent, so every downstream guard passed, and the
/// correction was spliced into the middle of a word while the words that fell
/// outside the slid window ("ashler", "versal") were never corrected at all.
final class BurstAlignmentTests: XCTestCase {
    private let existing = "ping Ashlr.AI about the cooper netties rollout"
    private let pasted = "ping ashler about the cuban eats rollout on versal"

    // MARK: the insertion point

    func testInsertionInFrontOfTextThatStartsTheSameWayIsAmbiguous() {
        let after = pasted + existing
        let delta = TextDiff.delta(from: existing, to: after)
        // The naive window starts after the shared "ping ".
        XCTAssertEqual(delta.location, 5)
        XCTAssertEqual(delta.inserted, pasted.utf16.count)
        XCTAssertEqual(delta.removed, 0)
        // ...and could just as well have started anywhere in 0...5.
        XCTAssertEqual(delta.slideLeft, 5)
        XCTAssertEqual(delta.slideRight, 0)
        XCTAssertFalse(delta.anchored)
        XCTAssertTrue(delta.isAmbiguous)
        // The slid window is not what arrived: it ends with the old text's "ping ".
        XCTAssertEqual(TextDiff.substring(after, utf16: delta.insertedRange),
                       "ashler about the cuban eats rollout on versalping ")
    }

    func testCaretPinsTheInsertionToWhatActuallyArrived() {
        let after = pasted + existing
        let delta = TextDiff.delta(from: existing, to: after, caretEnd: pasted.utf16.count)
        XCTAssertEqual(delta.location, 0)
        XCTAssertEqual(delta.inserted, pasted.utf16.count)
        XCTAssertTrue(delta.anchored)
        XCTAssertFalse(delta.isAmbiguous)
        XCTAssertEqual(TextDiff.substring(after, utf16: delta.insertedRange), pasted)
    }

    func testCaretOutsideThePlayIsNotBelieved() {
        let after = pasted + existing
        // A caret that cannot have produced this text (the user moved it, or
        // the app answered stale) leaves the window a guess, not an anchor.
        let delta = TextDiff.delta(from: existing, to: after, caretEnd: 3)
        XCTAssertFalse(delta.anchored)
        XCTAssertTrue(delta.isAmbiguous)
    }

    func testOrdinaryInsertionIsNotAmbiguous() {
        // Appending to an empty field, and to a sentence that shares nothing
        // with what arrives: no play, so no caret is needed.
        let a = TextDiff.delta(from: "", to: pasted)
        XCTAssertEqual(a.location, 0)
        XCTAssertFalse(a.isAmbiguous)

        let b = TextDiff.delta(from: "Hi. ", to: "Hi. " + pasted)
        XCTAssertEqual(b.location, 4)
        XCTAssertEqual(b.slideLeft, 0)
        XCTAssertEqual(b.slideRight, 0)
        XCTAssertFalse(b.isAmbiguous)
    }

    func testSlideRightIsMeasuredToo() {
        // "ab" inserted in front of "ab" can be the first or the second copy.
        let delta = TextDiff.delta(from: "abc", to: "ababc")
        XCTAssertEqual(delta.inserted, 2)
        XCTAssertTrue(delta.isAmbiguous)
        XCTAssertEqual(delta.slideLeft + delta.slideRight, 2)
        // The caret resolves it: ending at 2 means the leading copy arrived.
        let anchored = TextDiff.delta(from: "abc", to: "ababc", caretEnd: 2)
        XCTAssertEqual(anchored.location, 0)
        XCTAssertTrue(anchored.anchored)
    }

    func testReplacementReportsNoPlay() {
        let delta = TextDiff.delta(from: "ping ashler", to: "ping Ashlr.AI")
        XCTAssertEqual(delta.removed, 6)
        XCTAssertEqual(delta.slideLeft, 0)
        XCTAssertEqual(delta.slideRight, 0)
        XCTAssertFalse(delta.isAmbiguous)
    }

    // MARK: the detector

    func testBurstInFrontOfExistingTextIsSkippedWithoutACaret() {
        let d = BurstDetector(initialText: existing)
        d.record(text: pasted + existing, at: 1.0)
        guard case .skipped(let why) = d.settle(at: 1.8) else {
            return XCTFail("an insertion that cannot be located must never be rewritten")
        }
        XCTAssertTrue(why.hasPrefix("insertion point is ambiguous"), why)
    }

    func testBurstInFrontOfExistingTextFiresOnTheRightSpanWithACaret() {
        let d = BurstDetector(initialText: existing)
        let after = pasted + existing
        d.record(text: after, at: 1.0)
        guard case .burst(let burst) = d.settle(at: 1.8, caretEnd: pasted.utf16.count) else {
            return XCTFail("expected a burst")
        }
        XCTAssertEqual(burst.range, NSRange(location: 0, length: pasted.utf16.count))
        XCTAssertEqual(burst.text, pasted)
        XCTAssertEqual(burst.fullText, after)
        // The burst is exactly the span it claims to be.
        XCTAssertEqual(TextDiff.substring(burst.fullText, utf16: burst.range), burst.text)
    }

    func testBurstBetweenTwoSentencesFiresOnTheRightSpan() {
        let before = "Morning. "
        let tail = " Thanks."
        let d = BurstDetector(initialText: before + tail)
        let after = before + pasted + tail
        d.record(text: after, at: 1.0)
        guard case .burst(let burst) = d.settle(at: 1.8, caretEnd: (before + pasted).utf16.count) else {
            return XCTFail("expected a burst")
        }
        XCTAssertEqual(burst.range, NSRange(location: before.utf16.count, length: pasted.utf16.count))
        XCTAssertEqual(burst.text, pasted)
    }

    // MARK: the splice

    /// Several corrections in one burst, with the user's own text on both
    /// sides. The whole burst is replaced in a single splice, so no correction
    /// can shift another one out of position.
    func testMultipleReplacementsInOneBurstLandTogether() {
        let before = "Note: "
        let tail = " Thanks."
        let output = "ping Ashlr.AI about the Kubernetes rollout on Vercel"
        let full = before + pasted + tail
        let burst = Burst(range: NSRange(location: before.utf16.count, length: pasted.utf16.count),
                          text: pasted, fullText: full)
        let response = NormalizeResponse(
            input: pasted, output: output, changed: true,
            replacements: [
                FixReplacement(start: 5, end: 11, original: "ashler", replacement: "Ashlr.AI"),
                FixReplacement(start: 22, end: 32, original: "cuban eats", replacement: "Kubernetes"),
                FixReplacement(start: 44, end: 50, original: "versal", replacement: "Vercel"),
            ],
            summary: "3 corrections")

        guard case .success(let plan) = RewritePlan.make(burst: burst, response: response, currentFieldText: full) else {
            return XCTFail("expected a plan")
        }
        XCTAssertEqual(plan.range, burst.range)
        XCTAssertEqual(plan.previousText, pasted)
        XCTAssertEqual(plan.newText, output)
        XCTAssertEqual(plan.splicedFullText, before + output + tail)
        // Nothing of the user's own text was touched.
        XCTAssertTrue(plan.splicedFullText.hasPrefix(before))
        XCTAssertTrue(plan.splicedFullText.hasSuffix(tail))
        // The caret lands after the corrected span, not after the original.
        XCTAssertEqual(plan.caret, NSRange(location: before.utf16.count + output.utf16.count, length: 0))
        // And the plan is self-consistent: replacing the claimed span with the
        // claimed text gives exactly the claimed result.
        XCTAssertEqual(TextDiff.splice(full, utf16: plan.range, with: plan.newText), plan.splicedFullText)
    }

    func testStaleSnapshotIsRefused() {
        let full = "Note: " + pasted
        let burst = Burst(range: NSRange(location: 6, length: pasted.utf16.count), text: pasted, fullText: full)
        let response = NormalizeResponse(input: pasted, output: "ping Ashlr.AI about the Kubernetes rollout on Vercel",
                                         changed: true, replacements: [], summary: "2 corrections")
        // The user typed one more character while the API was answering.
        XCTAssertEqual(RewritePlan.make(burst: burst, response: response, currentFieldText: full + "!"),
                       .failure(.fieldChanged))
        XCTAssertEqual(RewritePlan.make(burst: burst, response: response, currentFieldText: "something else entirely"),
                       .failure(.fieldChanged))
    }

    func testBurstRangeThatNoLongerHoldsTheBurstTextIsRefused() {
        // Same text length, wrong offset: the guard is on the content of the
        // span, not just on its bounds.
        let full = "Note: " + pasted
        let burst = Burst(range: NSRange(location: 5, length: pasted.utf16.count), text: pasted, fullText: full)
        let response = NormalizeResponse(input: pasted, output: "ping Ashlr.AI about the Kubernetes rollout on Vercel",
                                         changed: true, replacements: [], summary: "2 corrections")
        XCTAssertEqual(RewritePlan.make(burst: burst, response: response, currentFieldText: full),
                       .failure(.rangeOutOfBounds))
    }

    func testUndoPutsBackExactlyWhatWasThere() {
        let before = "Note: "
        let tail = " Thanks."
        let output = "ping Ashlr.AI about the Kubernetes rollout on Vercel"
        let entry = UndoLedger.Entry(fieldKey: "1:2", range: NSRange(location: before.utf16.count, length: pasted.utf16.count),
                                     correctedText: output, previousText: pasted,
                                     fieldTextAfter: before + output + tail)
        XCTAssertEqual(entry.fieldTextBefore, before + pasted + tail)
    }
}
