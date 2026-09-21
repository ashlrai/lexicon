import XCTest
@testable import LexiconBarKit

/// The arithmetic behind "the correction only half went in".
///
/// This is the one failure in the app that can destroy text the user wrote.
/// The keystroke write posts a run of `CGEvent`s, so a correction over twenty
/// units is several of them; a chunk that could not be posted used to be
/// skipped in silence, and the engine then compared the field against the value
/// the plan was made from, found it different and told the user the write had
/// failed. The field held half a replacement, the original span was gone and
/// nothing had been recorded that could put it back.
///
/// What a short write left behind is computed here. Every case below asserts
/// the same two things: the field text the engine will check its read against,
/// and that undoing the entry restores exactly what the user had. The second is
/// the one that matters.
final class PartialWriteTests: XCTestCase {
    private let key = "field-1"
    private let before = "I use ashler daily"

    /// "I use ashler daily" with "ashler" becoming "Ashlr.AI".
    private func midFieldPlan() -> RewritePlan.Plan {
        plan(before: before, range: NSRange(location: 6, length: 6), replacement: "Ashlr.AI")
    }

    private func plan(before: String, range: NSRange, replacement: String) -> RewritePlan.Plan {
        RewritePlan.Plan(range: range,
                         previousText: TextDiff.substring(before, utf16: range)!,
                         newText: replacement,
                         splicedFullText: TextDiff.splice(before, utf16: range, with: replacement)!)
    }

    func testHalfATypedReplacementIsDescribedAndUndoable() throws {
        // "Ashl" of "Ashlr.AI" landed; the selected "ashler" is already gone.
        let partial = try XCTUnwrap(PartialWrite.overSelection(plan: midFieldPlan(), before: before, unitsTyped: 4))

        XCTAssertEqual(partial.fieldText, "I use Ashl daily")
        XCTAssertEqual(partial.writtenText, "Ashl")
        XCTAssertEqual(partial.originalText, "ashler")
        XCTAssertEqual(partial.undone, before)
    }

    func testTheEntryPutsTheUsersOwnTextBack() throws {
        let partial = try XCTUnwrap(PartialWrite.overSelection(plan: midFieldPlan(), before: before, unitsTyped: 4))

        let entry = partial.entry(fieldKey: key)
        XCTAssertEqual(entry.fieldKey, key)
        XCTAssertEqual(entry.fieldTextAfter, partial.fieldText)
        XCTAssertEqual(entry.fieldTextBefore, before)

        // And the ledger will actually offer it: the field holds exactly what
        // the entry says it does.
        var ledger = UndoLedger()
        ledger.record(entry)
        XCTAssertTrue(ledger.canUndo(fieldKey: key, currentText: partial.fieldText))
    }

    func testOneUnitIsStillAPartialWrite() throws {
        let partial = try XCTUnwrap(PartialWrite.overSelection(plan: midFieldPlan(), before: before, unitsTyped: 1))

        XCTAssertEqual(partial.fieldText, "I use A daily")
        XCTAssertEqual(partial.undone, before)
    }

    func testNothingTypedIsNotAPartialWrite() {
        // A selection that was never typed over still holds the user's text.
        XCTAssertNil(PartialWrite.overSelection(plan: midFieldPlan(), before: before, unitsTyped: 0))
        XCTAssertNil(PartialWrite.overSelection(plan: midFieldPlan(), before: before, unitsTyped: -3))
    }

    func testAFullyTypedReplacementIsNotAPartialWrite() {
        let plan = midFieldPlan()
        let units = plan.newText.utf16.count
        XCTAssertNil(PartialWrite.overSelection(plan: plan, before: before, unitsTyped: units))
        XCTAssertNil(PartialWrite.overSelection(plan: plan, before: before, unitsTyped: units + 5))
    }

    func testAFieldThatNoLongerHoldsThePlansSpanIsRefused() {
        // The premise is already false, so there is no state to describe and
        // the engine must leave the field alone rather than guess at one.
        XCTAssertNil(PartialWrite.overSelection(plan: midFieldPlan(), before: "I use something else", unitsTyped: 4))
        XCTAssertNil(PartialWrite.overSelection(plan: midFieldPlan(), before: "short", unitsTyped: 4))
    }

    func testEverySelectionProgressRoundTripsBackToTheOriginal() throws {
        let plan = midFieldPlan()

        for typed in 1..<plan.newText.utf16.count {
            let partial = try XCTUnwrap(PartialWrite.overSelection(plan: plan, before: before, unitsTyped: typed),
                                        "no state described for \(typed) units")
            XCTAssertEqual(partial.undone, before, "\(typed) units")
            XCTAssertEqual(partial.entry(fieldKey: key).fieldTextBefore, before, "\(typed) units")
        }
    }

    /// The write arriving in full after the caller gave up on it. Without a
    /// description of that state the correction would sit in the field with no
    /// ledger entry behind it.
    func testTheWholeCorrectionIsDescribedForALateArrival() {
        let plan = midFieldPlan()
        let whole = PartialWrite.whole(plan)

        XCTAssertEqual(whole.fieldText, plan.splicedFullText)
        XCTAssertEqual(whole.writtenText, plan.newText)
        XCTAssertEqual(whole.undone, before)
        XCTAssertEqual(whole.entry(fieldKey: key).fieldTextBefore, before)
    }

    /// A replacement wider than one UTF-16 unit per character. The undo splices
    /// back over what was written, which is counted in units and not in
    /// characters, so anything that measures it the other way puts the user's
    /// text back in the wrong place.
    func testAstralCharactersRoundTripByUnitsNotCharacters() throws {
        let before = "ship it soon"
        let plan = plan(before: before, range: NSRange(location: 5, length: 2), replacement: "\u{1F680}\u{1F680}ok")

        for typed in stride(from: 2, to: plan.newText.utf16.count, by: 2) {
            let partial = try XCTUnwrap(PartialWrite.overSelection(plan: plan, before: before, unitsTyped: typed))
            XCTAssertEqual(partial.undone, before, "\(typed) units")
            XCTAssertEqual(partial.entry(fieldKey: "f").fieldTextBefore, before, "\(typed) units")
        }
    }
}
