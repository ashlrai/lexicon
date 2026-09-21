import XCTest
@testable import LexiconBarKit

/// What the engine concludes about a synthesized write that did not obviously
/// work, from the readings the field hands back.
///
/// `PartialWriteTests` covers the arithmetic: given that exactly this much
/// landed, here is the field and here is the undo. It could only ever cover
/// that, because it hands the arithmetic a synthetic field and asks it a
/// question it has already answered. The first partial-write recovery on
/// Windows shipped green on exactly those tests while racing the keystrokes it
/// was recovering from: it took one immediate reading of a field whose app had
/// not yet processed the input, concluded from the single state the arithmetic
/// predicted, and got the two most likely outcomes wrong.
///
/// So these tests are about time and evidence rather than about arithmetic.
/// They script the readings a field returns while the app catches up, and hold
/// the settle to three properties:
///
/// - a field that has not caught up yet is not a field that ignored us;
/// - whatever it settles on, the recorded undo puts back exactly the text the
///   user had;
/// - keystrokes that were posted but never shown are never written over.
final class KeystrokeSettleTests: XCTestCase {
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

    /// The engine's own `describe`, as `FixEngine.write` builds it.
    private func describe(_ plan: RewritePlan.Plan, before: String) -> (Int) -> PartialWrite? {
        { landed in
            landed >= plan.newText.utf16.count
                ? PartialWrite.whole(plan)
                : PartialWrite.overSelection(plan: plan, before: before, unitsTyped: landed)
        }
    }

    /// A field that answers a scripted sequence of readings, then repeats the
    /// last one, and a budget of one wait per scripted reading after the first.
    /// The stand-in for an app processing synthesized input on its own event
    /// loop, which is the thing the real settle is waiting for and the thing a
    /// single read cannot see.
    private final class ScriptedField: SettlePoll {
        private let readings: [String]
        private var at = 0

        /// How many times the settle looked.
        private(set) var reads = 0
        /// How many times it chose to wait rather than decide.
        private(set) var waits = 0

        init(_ readings: String...) { self.readings = readings }

        func read() -> String? {
            reads += 1
            return readings[min(at, readings.count - 1)]
        }

        func keepWaiting() -> Bool {
            guard at < readings.count - 1 else { return false }
            at += 1
            waits += 1
            return true
        }
    }

    private final class NullField: SettlePoll {
        func read() -> String? { nil }
        func keepWaiting() -> Bool { false }
    }

    private func resolve(_ plan: RewritePlan.Plan, before: String, posted: Int, field: SettlePoll) -> SettledWrite {
        KeystrokeSettle.resolve(before: before, complete: plan.splicedFullText,
                                units: plan.newText.utf16.count, posted: posted,
                                describe: describe(plan, before: before), poll: field)
    }

    // MARK: the app has not caught up yet

    /// The first failure a single read produced: the app had consumed nothing
    /// when it looked, so the engine called the field unchanged, wrote the
    /// whole value, and the queued characters landed on top of it. The field
    /// was then corrupt and the undo entry no longer matched it, so the offer
    /// went away.
    func testKeystrokesThatHaveNotBeenProcessedYetAreWaitedFor() {
        let plan = midFieldPlan()
        // Nothing, nothing, then all of it: the app got round to its queue.
        let field = ScriptedField(before, before, plan.splicedFullText)

        XCTAssertEqual(resolve(plan, before: before, posted: 8, field: field), .complete)
        XCTAssertEqual(field.reads, 3)
    }

    /// The same, stopping half way: the app consumed part of the queue and
    /// stopped. A single read taken before it started would have called this an
    /// untouched field.
    func testAWriteThatLandsHalfWayThroughTheWindowIsStillSeen() throws {
        let plan = midFieldPlan()
        let half = try XCTUnwrap(PartialWrite.overSelection(plan: plan, before: before, unitsTyped: 4)).fieldText
        let field = ScriptedField(before, before, half)

        guard case .half(let partial) = resolve(plan, before: before, posted: 4, field: field) else {
            return XCTFail("expected a half-landed write")
        }
        XCTAssertEqual(partial.fieldText, half)
        XCTAssertEqual(partial.undone, before)
    }

    // MARK: the count is a bound, not a fact

    /// The second failure: the app consumed fewer units than were posted. The
    /// old code demanded the field equal the one state the count predicted, did
    /// not find it, and answered "landed somewhere this cannot account for"
    /// with nothing recorded, which is the exact state the whole recovery
    /// exists to abolish.
    func testFewerUnitsThanPostedIsStillIdentifiedAndUndoable() throws {
        let plan = midFieldPlan()
        let two = try XCTUnwrap(PartialWrite.overSelection(plan: plan, before: before, unitsTyped: 2)).fieldText
        let field = ScriptedField(two, two, two)

        guard case .half(let partial) = resolve(plan, before: before, posted: 6, field: field) else {
            return XCTFail("expected a half-landed write")
        }
        XCTAssertEqual(partial.fieldText, "I use As daily")
        XCTAssertEqual(partial.undone, before)
        XCTAssertEqual(partial.entry(fieldKey: key).fieldTextBefore, before)
    }

    /// A state the count does not bound is still identified, because the field
    /// is the evidence and every hypothesis undoes to the same original text.
    /// Answering "unexplained" here would leave the user with a half-written
    /// field and no way back.
    func testMoreUnitsThanPostedAreIdentifiedRatherThanRefused() throws {
        let plan = midFieldPlan()
        let seven = try XCTUnwrap(PartialWrite.overSelection(plan: plan, before: before, unitsTyped: 7)).fieldText
        let field = ScriptedField(seven, seven)

        guard case .half(let partial) = resolve(plan, before: before, posted: 2, field: field) else {
            return XCTFail("expected a half-landed write")
        }
        XCTAssertEqual(partial.fieldText, seven)
        XCTAssertEqual(partial.undone, before)
    }

    /// The property that matters, over every state the app could stop at and
    /// every count it could have been told about.
    func testEverySettledStateUndoesBackToWhatTheUserHad() throws {
        let plan = midFieldPlan()
        let units = plan.newText.utf16.count

        for landed in 1..<units {
            let text = try XCTUnwrap(PartialWrite.overSelection(plan: plan, before: before, unitsTyped: landed)).fieldText
            for posted in 0...units {
                guard case .half(let partial) = resolve(plan, before: before, posted: posted,
                                                        field: ScriptedField(text, text, text)) else {
                    return XCTFail("landed \(landed), posted \(posted): expected a half-landed write")
                }
                XCTAssertEqual(partial.undone, before, "landed \(landed), posted \(posted)")
                XCTAssertEqual(partial.entry(fieldKey: key).fieldTextBefore, before, "landed \(landed), posted \(posted)")
            }
        }
    }

    // MARK: nothing landed at all

    /// No key event could be built, so nothing was posted, nothing is queued
    /// and nothing can arrive later. The engine is free to repair the field
    /// with the whole-value write, and it must not spend the settle window
    /// finding that out.
    func testNothingPostedIsDecidedOnTheFirstLook() {
        let field = ScriptedField(before, before, before)

        guard case .untouched(let pending) = resolve(midFieldPlan(), before: before, posted: 0, field: field) else {
            return XCTFail("expected an untouched field")
        }
        XCTAssertNil(pending)
        XCTAssertEqual(field.reads, 1)
        XCTAssertEqual(field.waits, 0)
    }

    /// Keystrokes that went out and the field never showed. The caller must not
    /// write over them, so the settle waits out the whole window first and then
    /// hands back what the field will hold if they do turn up, which is what
    /// makes a late arrival reversible.
    func testPostedKeystrokesThatNeverAppearAreWaitedOutAndDescribed() throws {
        let field = ScriptedField(before, before, before, before)

        guard case .untouched(let pending) = resolve(midFieldPlan(), before: before, posted: 4, field: field) else {
            return XCTFail("expected an untouched field")
        }
        XCTAssertEqual(field.reads, 4)
        XCTAssertEqual(field.waits, 3)
        let described = try XCTUnwrap(pending)
        XCTAssertEqual(described.fieldText, "I use Ashl daily")
        XCTAssertEqual(described.undone, before)
    }

    /// The same when all of it was posted: the state that would arrive is the
    /// whole correction, and it needs the same ledger entry a write that worked
    /// first time gets.
    func testEverythingPostedAndNothingShownIsDescribedAsTheWholeCorrection() throws {
        let plan = midFieldPlan()
        let field = ScriptedField(before, before)

        guard case .untouched(let pending) = resolve(plan, before: before,
                                                     posted: plan.newText.utf16.count, field: field) else {
            return XCTFail("expected an untouched field")
        }
        let described = try XCTUnwrap(pending)
        XCTAssertEqual(described.fieldText, plan.splicedFullText)
        XCTAssertEqual(described.undone, before)
    }

    /// A replacement that starts with the text it replaces leaves the field
    /// holding exactly what it held before, for a while. That reading is the
    /// truthful one: the user's text is all still there, and calling it a
    /// partial write would record an undo that deletes characters the user
    /// typed.
    func testAReplacementWhosePrefixIsTheOriginalReadsAsUntouched() {
        let plan = plan(before: before, range: NSRange(location: 6, length: 6), replacement: "ashlerly")
        let field = ScriptedField(before, before)

        guard case .untouched(let pending) = resolve(plan, before: before, posted: 6, field: field) else {
            return XCTFail("expected an untouched field")
        }
        // Those six units arriving would not change a character of the field,
        // so there is nothing to offer to take back out.
        XCTAssertNil(pending)
    }

    /// The write arriving late and in full after the caller gave up on it.
    func testALateFullArrivalIsComplete() {
        let plan = midFieldPlan()
        let field = ScriptedField(before, plan.splicedFullText)

        XCTAssertEqual(resolve(plan, before: before, posted: plan.newText.utf16.count, field: field), .complete)
    }

    // MARK: states the engine refuses to act on

    /// Text that no hypothesis explains: the user typed, or another app wrote,
    /// while this was happening. The engine stops rather than write on top of a
    /// field it no longer understands.
    func testAFieldHoldingSomethingElseEntirelyIsUnexplained() {
        let field = ScriptedField("something else altogether", "something else altogether")

        XCTAssertEqual(resolve(midFieldPlan(), before: before, posted: 4, field: field),
                       .unexplained("something else altogether"))
    }

    /// A field that cannot be read is not a field that was written to.
    func testAFieldThatCannotBeReadIsUnexplainedRatherThanAssumed() {
        guard case .unexplained = resolve(midFieldPlan(), before: before, posted: 4, field: NullField()) else {
            return XCTFail("expected an unexplained field")
        }
    }
}
