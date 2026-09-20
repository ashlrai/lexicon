import XCTest
import CoreGraphics
@testable import LexiconBarKit

final class BubbleSupportTests: XCTestCase {
    private func alias(_ original: String, _ canonical: String) -> Replacement {
        Replacement(original: original, replacement: canonical, reason: "alias", confidence: 1)
    }

    private func phonetic(_ original: String, _ canonical: String) -> Replacement {
        Replacement(original: original, replacement: canonical, reason: "phonetic", confidence: 0.9)
    }

    // MARK: text formatting

    func testOneReplacementFillsOneLineWithNoOverflow() throws {
        let content = try XCTUnwrap(CorrectionBubble.content(for: [alias("ashler", "Ashlr.AI")]))
        XCTAssertEqual(content.lines.count, 1)
        XCTAssertEqual(content.lines[0].original, "ashler")
        XCTAssertEqual(content.lines[0].canonical, "Ashlr.AI")
        XCTAssertEqual(content.lines[0].label, "ashler \u{2192} Ashlr.AI")
        XCTAssertNil(content.overflow)
        XCTAssertEqual(content.total, 1)
        XCTAssertEqual(content.title, "Fixed 1 word")
    }

    func testThreeReplacementsFillEveryLineWithNoOverflow() throws {
        let content = try XCTUnwrap(CorrectionBubble.content(for: [
            alias("ashler", "Ashlr.AI"),
            alias("cooper netties", "Kubernetes"),
            alias("vessel", "Vercel"),
        ]))
        XCTAssertEqual(content.lines.count, 3)
        // The strikethrough/bold pairs, in the API's order.
        XCTAssertEqual(content.lines.map(\.original), ["ashler", "cooper netties", "vessel"])
        XCTAssertEqual(content.lines.map(\.canonical), ["Ashlr.AI", "Kubernetes", "Vercel"])
        XCTAssertNil(content.overflow)
        XCTAssertEqual(content.title, "Fixed 3 words")
    }

    func testSevenReplacementsShowThreeLinesAndCountTheRest() throws {
        let replacements = (1...7).map { alias("heard\($0)", "Meant\($0)") }
        let content = try XCTUnwrap(CorrectionBubble.content(for: replacements))
        XCTAssertEqual(content.lines.count, 3)
        XCTAssertEqual(content.lines.map(\.original), ["heard1", "heard2", "heard3"])
        XCTAssertEqual(content.overflow, "+4 more")
        XCTAssertEqual(content.total, 7)
        XCTAssertEqual(content.title, "Fixed 7 words")
        XCTAssertEqual(content.accessibilityLabel,
                       "Fixed 7 words, heard1 \u{2192} Meant1, heard2 \u{2192} Meant2, heard3 \u{2192} Meant3, +4 more")
    }

    func testNoReplacementsMeansNoBubble() {
        XCTAssertNil(CorrectionBubble.content(for: []))
    }

    func testMaxLinesIsHonouredAndNeverZero() throws {
        let replacements = (1...5).map { alias("h\($0)", "M\($0)") }
        XCTAssertEqual(CorrectionBubble.content(for: replacements, maxLines: 2)?.lines.count, 2)
        XCTAssertEqual(CorrectionBubble.content(for: replacements, maxLines: 2)?.overflow, "+3 more")
        // A nonsense limit still renders one line rather than an empty bubble.
        XCTAssertEqual(CorrectionBubble.content(for: replacements, maxLines: 0)?.lines.count, 1)
    }

    // MARK: which actions appear

    func testAliasOnlyOffersUndoAndNever() throws {
        let content = try XCTUnwrap(CorrectionBubble.content(for: [alias("ashler", "Ashlr.AI")]))
        XCTAssertEqual(content.actions, [.undo, .never])
        XCTAssertFalse(content.actions.contains(.add))
    }

    func testPhoneticOffersAdd() throws {
        let content = try XCTUnwrap(CorrectionBubble.content(for: [phonetic("kuber netties", "Kubernetes")]))
        XCTAssertEqual(content.actions, [.undo, .never, .add])
    }

    func testFuzzyOffersAdd() {
        let fuzzy = Replacement(original: "vercell", replacement: "Vercel", reason: "fuzzy", confidence: 0.86)
        XCTAssertEqual(CorrectionBubble.actions(for: [fuzzy]), [.undo, .never, .add])
    }

    func testMissingOrUnknownReasonDoesNotOfferAdd() {
        let noReason = Replacement(original: "a", replacement: "B", reason: nil, confidence: nil)
        let odd = Replacement(original: "a", replacement: "B", reason: "handwritten", confidence: 1)
        XCTAssertEqual(CorrectionBubble.actions(for: [noReason]), [.undo, .never])
        XCTAssertEqual(CorrectionBubble.actions(for: [odd]), [.undo, .never])
    }

    func testOneGuessAmongAliasesIsEnoughToOfferAdd() {
        XCTAssertEqual(CorrectionBubble.actions(for: [alias("a", "A"), phonetic("b", "B")]), [.undo, .never, .add])
    }

    func testReasonMatchingIsCaseInsensitive() {
        XCTAssertTrue(CorrectionBubble.isGuess(reason: "Phonetic"))
        XCTAssertTrue(CorrectionBubble.isGuess(reason: "FUZZY"))
        XCTAssertFalse(CorrectionBubble.isGuess(reason: "alias"))
        XCTAssertFalse(CorrectionBubble.isGuess(reason: nil))
    }

    // MARK: which replacement Never/Add act on

    func testTargetIsTheGuessWhenThereIsOne() throws {
        let content = try XCTUnwrap(CorrectionBubble.content(for: [alias("ashler", "Ashlr.AI"), phonetic("kuber netties", "Kubernetes")]))
        XCTAssertEqual(content.target.original, "kuber netties")
        XCTAssertEqual(content.target.canonical, "Kubernetes")
    }

    func testTargetFallsBackToTheFirstReplacement() throws {
        let content = try XCTUnwrap(CorrectionBubble.content(for: [alias("ashler", "Ashlr.AI"), alias("vessel", "Vercel")]))
        XCTAssertEqual(content.target.original, "ashler")
    }

    // MARK: placement

    /// A roomy screen with the caret in the middle: straight below, left-aligned.
    private let screen = CGRect(x: 0, y: 0, width: 1440, height: 850)
    private let bubble = CGSize(width: 280, height: 96)

    func testPreferredSpotIsBelowAndLeftAlignedWithTheCaret() {
        let caret = CGRect(x: 400, y: 500, width: 2, height: 18)
        let origin = BubblePlacement.origin(caret: caret, screen: screen, bubble: bubble)
        XCTAssertEqual(origin.x, 400)
        XCTAssertEqual(origin.y, 500 - 8 - 96)
    }

    func testOffScreenRightIsPulledBackToTheRightEdge() {
        let caret = CGRect(x: 1400, y: 500, width: 2, height: 18)
        let origin = BubblePlacement.origin(caret: caret, screen: screen, bubble: bubble)
        XCTAssertEqual(origin.x, 1440 - 280)
        XCTAssertLessThanOrEqual(origin.x + bubble.width, screen.maxX)
    }

    func testOffScreenLeftIsPushedToTheLeftEdge() {
        let caret = CGRect(x: -40, y: 500, width: 2, height: 18)
        let origin = BubblePlacement.origin(caret: caret, screen: screen, bubble: bubble)
        XCTAssertEqual(origin.x, screen.minX)
    }

    /// A caret near the bottom has no room below, so the bubble flips above it
    /// rather than covering the line being typed.
    func testNoRoomBelowFlipsAboveTheCaret() {
        let caret = CGRect(x: 400, y: 20, width: 2, height: 18)
        let origin = BubblePlacement.origin(caret: caret, screen: screen, bubble: bubble)
        XCTAssertEqual(origin.y, caret.maxY + 8)
        XCTAssertGreaterThanOrEqual(origin.y, screen.minY)
    }

    /// Short screen: neither below nor above fits, so it is clamped inside.
    func testNoRoomEitherWayClampsInsideTheScreen() {
        let short = CGRect(x: 0, y: 0, width: 1440, height: 110)
        let caret = CGRect(x: 400, y: 40, width: 2, height: 18)
        let origin = BubblePlacement.origin(caret: caret, screen: short, bubble: bubble)
        XCTAssertGreaterThanOrEqual(origin.y, short.minY)
        XCTAssertLessThanOrEqual(origin.y + bubble.height, short.maxY)
    }

    /// The menu bar and the notch are already out of `visibleFrame`, so a
    /// caret at the very top must not push the bubble into that band.
    func testFlippedBubbleNeverCoversTheMenuBarBand() {
        let visible = CGRect(x: 0, y: 0, width: 1440, height: 850)  // 900-high display, 50 for menu bar/notch
        let caret = CGRect(x: 400, y: 838, width: 2, height: 18)
        let origin = BubblePlacement.origin(caret: caret, screen: visible, bubble: bubble)
        XCTAssertLessThanOrEqual(origin.y + bubble.height, visible.maxY)
    }

    /// A screen origin other than zero (a second display to the right or
    /// below) must be respected, not treated as 0,0.
    func testSecondDisplayOffsetIsRespected() {
        let right = CGRect(x: 1440, y: 200, width: 1920, height: 1080)
        let caret = CGRect(x: 3300, y: 260, width: 2, height: 18)
        let origin = BubblePlacement.origin(caret: caret, screen: right, bubble: bubble)
        XCTAssertLessThanOrEqual(origin.x + bubble.width, right.maxX)
        XCTAssertGreaterThanOrEqual(origin.x, right.minX)
        XCTAssertGreaterThanOrEqual(origin.y, right.minY)
        XCTAssertLessThanOrEqual(origin.y + bubble.height, right.maxY)
    }

    func testScreenContainingPointPicksTheRightDisplay() {
        let main = CGRect(x: 0, y: 0, width: 1440, height: 850)
        let right = CGRect(x: 1440, y: 200, width: 1920, height: 1080)
        XCTAssertEqual(BubblePlacement.screen(containing: CGPoint(x: 200, y: 200), screens: [main, right]), main)
        XCTAssertEqual(BubblePlacement.screen(containing: CGPoint(x: 2000, y: 700), screens: [main, right]), right)
    }

    func testAPointOutsideEveryScreenFallsBackToTheNearestOne() {
        let main = CGRect(x: 0, y: 0, width: 1440, height: 850)
        let right = CGRect(x: 1440, y: 200, width: 1920, height: 1080)
        // Just past the right display's outer edge.
        XCTAssertEqual(BubblePlacement.screen(containing: CGPoint(x: 3400, y: 700), screens: [main, right]), right)
        XCTAssertNil(BubblePlacement.screen(containing: .zero, screens: []))
    }
}
