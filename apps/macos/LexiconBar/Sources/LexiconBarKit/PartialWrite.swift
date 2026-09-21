import Foundation

/// What a synthesized-keystroke write left in the field when only part of it
/// landed, and the ledger entry that takes it back out again.
///
/// The keystroke path is the only write in this app that can half-finish.
/// `AXSelectedText` and `AXValue` either replace what they were handed or they
/// do not; key events are posted one chunk at a time into a queue the target
/// app drains on its own run loop, so an app that consumes some of them and
/// stops leaves the field holding part of a replacement with the user's own
/// span already gone.
///
/// The engine used to treat anything short of complete success as "nothing
/// happened", fall through to the whole-value write, find the field no longer
/// held what the plan was made from and report that the write had failed. All
/// three of those sentences were wrong at once: the field held half a
/// replacement, the user's original span was already gone, and no undo had
/// been recorded. Corrupting text the user wrote is the worst thing this app
/// can do, so the arithmetic that says exactly what the field must hold lives
/// here, in `LexiconBarKit`, where it is tested.
///
/// It is a hypothesis rather than a fact. The caller re-reads the field and
/// acts on this only when ``fieldText`` matches what it finds; a field holding
/// anything else is one the engine no longer understands, and it says so
/// instead of guessing an offset to splice at.
///
/// Ported from `PartialWrite.cs` in the Windows core, which fixed this class of
/// bug first.
public struct PartialWrite: Equatable, Sendable {
    /// What the field must hold if exactly this much landed.
    public let fieldText: String
    /// The span of the user's own text that the partial write overwrote.
    public let range: NSRange
    /// The leading part of the replacement that did land.
    public let writtenText: String
    /// The user's text that the partial write consumed.
    public let originalText: String

    public init(fieldText: String, range: NSRange, writtenText: String, originalText: String) {
        self.fieldText = fieldText
        self.range = range
        self.writtenText = writtenText
        self.originalText = originalText
    }

    /// The field's text with the partial write taken back out, which is what it
    /// held before. Nil when the splice no longer fits, which is the same
    /// "leave it alone" answer `TextDiff.splice` gives everywhere else.
    public var undone: String? {
        TextDiff.splice(fieldText,
                        utf16: NSRange(location: range.location, length: writtenText.utf16.count),
                        with: originalText)
    }

    /// The ledger entry whose undo puts ``originalText`` back.
    public func entry(fieldKey: String) -> UndoLedger.Entry {
        UndoLedger.Entry(fieldKey: fieldKey, range: range, correctedText: writtenText,
                         previousText: originalText, fieldTextAfter: fieldText)
    }

    /// A select-and-type write in which the first `unitsTyped` UTF-16 units of
    /// the replacement landed over the selected span and the rest did not.
    ///
    /// Nil when this is not a partial write at all: zero units leaves a
    /// selection intact and destroys nothing, and a full count is simply the
    /// write working. Nil too when `before` does not hold the plan's span,
    /// because then the premise is already false.
    ///
    /// `unitsTyped` is a count of UTF-16 units, and a prefix that ends between
    /// a surrogate pair is not a string. `UnicodeTyping` posts whole pairs, so
    /// the engine never asks about such a count; asked anyway, the substring
    /// below answers with a replacement character, the hypothesis then matches
    /// no real field, and the caller falls through to "unexplained" rather than
    /// splicing at an offset it invented.
    public static func overSelection(plan: RewritePlan.Plan, before: String, unitsTyped: Int) -> PartialWrite? {
        let length = plan.newText.utf16.count
        guard unitsTyped > 0, unitsTyped < length else { return nil }
        guard TextDiff.substring(before, utf16: plan.range) == plan.previousText else { return nil }
        guard let written = TextDiff.substring(plan.newText, utf16: NSRange(location: 0, length: unitsTyped)),
              let fieldText = TextDiff.splice(before, utf16: plan.range, with: written) else { return nil }
        return PartialWrite(fieldText: fieldText, range: plan.range,
                            writtenText: written, originalText: plan.previousText)
    }

    /// The whole correction, in the shape the settle and the ledger both take.
    ///
    /// ``overSelection(plan:before:unitsTyped:)`` answers nil for a full count,
    /// because a full count is the write simply working and there is nothing
    /// partial to describe. The settle still needs that state described: a
    /// write the system took in full can arrive after the engine has stopped
    /// waiting for it, and then it is the whole correction sitting in the field
    /// with no ledger entry behind it. Undoing this is the same splice the
    /// engine records when the write works first time.
    public static func whole(_ plan: RewritePlan.Plan) -> PartialWrite {
        PartialWrite(fieldText: plan.splicedFullText, range: plan.range,
                     writtenText: plan.newText, originalText: plan.previousText)
    }
}
