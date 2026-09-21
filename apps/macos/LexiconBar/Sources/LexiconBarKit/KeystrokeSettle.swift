import Foundation

/// One look at a field, and permission to look again.
///
/// The settle below has to re-read the field over a short window, which here
/// means an Accessibility call into another process and a sleep. Neither can
/// run in a unit test, so both sit behind this protocol and the whole decision
/// stays testable: `KeystrokeSettleTests` scripts the readings a field hands
/// back and asserts what the engine concludes from them.
public protocol SettlePoll {
    /// The field's text now, or nil when it cannot be read.
    func read() -> String?

    /// Waits a little and answers whether there is still time to look again.
    /// False ends the settle, and the last reading is the one acted on.
    func keepWaiting() -> Bool
}

/// What the field turned out to hold after synthesized keystrokes that did not
/// obviously work.
public enum SettledWrite: Equatable, Sendable {
    /// The whole replacement is in the field after all. The app was simply
    /// slower than the verification window.
    case complete

    /// The field holds a state `PartialWrite` describes exactly: part of the
    /// replacement is in, and part of the user's own text is gone. The caller
    /// repairs it where it can and records the undo either way.
    case half(PartialWrite)

    /// The field still holds the text the plan was made from. Nothing of ours
    /// is in it and nothing of the user's is missing.
    ///
    /// `pending` is what the field would hold if the keystrokes that were
    /// posted turned up after the settle window closed, or nil when nothing was
    /// posted and so nothing can still be in flight.
    case untouched(pending: PartialWrite?)

    /// The field holds something no hypothesis explains. The engine stops here
    /// rather than write on top of a field it no longer understands.
    case unexplained(String)
}

/// Works out what a synthesized-keystroke write actually did, by watching the
/// field rather than by trusting the count of what was posted.
///
/// Ported from `KeystrokeSettle.cs`, which exists because the first version of
/// the Windows partial-write recovery raced the very keystrokes it was
/// recovering from. It took a single immediate reading of the field and
/// demanded it equal the one state the arithmetic predicted, while the success
/// path beside it polled for 600 ms precisely because the target app processes
/// synthesized input on its own event loop. `CGEvent.post` only queues: it
/// hands the event to the window server and says nothing about what the app has
/// consumed. So the single reading found one of three things, and got two of
/// them wrong:
///
/// - nothing consumed yet, which read as "the field is unchanged", after which
///   the engine wrote the whole value and the queued characters landed on top
///   of it. The field was then corrupt and the undo entry, which claimed the
///   field held the spliced text, no longer matched it, so the offer was
///   withdrawn: corrupted text and no way back.
/// - some consumed but fewer than were posted, which read as "landed somewhere
///   this cannot account for" and left exactly the state the recovery was
///   written to abolish: half a replacement in the field, the user's span gone,
///   nothing recorded, and a message saying the write had failed.
/// - exactly the number posted, the only case the arithmetic's own tests could
///   reach, because they hand it a synthetic field.
///
/// So the settle polls the way the success path polls, and it identifies the
/// state by what the field holds rather than by what the count claims. Every
/// hypothesis `PartialWrite` can produce undoes back to the same original text,
/// so matching the field against all of them and taking whichever fits is safe,
/// and is strictly better than answering "unexplained" and leaving the user
/// with no undo.
///
/// The count is still worth something: it bounds how much can possibly have
/// landed, which is what lets the settle stop early instead of always burning
/// the full window. Here that bound is exact, where the Windows one adds a unit
/// to it: `SendInput` can be cut between a key down and its key up, which still
/// delivers the character, while `UnicodeTyping.post` builds both events for a
/// chunk before it posts either, so a chunk goes whole or not at all.
public enum KeystrokeSettle {
    /// Watches the field until it settles, and says what happened.
    ///
    /// - Parameters:
    ///   - before: The text the field held when the plan was made.
    ///   - complete: The text it holds if all of the write landed.
    ///   - units: How many UTF-16 units the write was.
    ///   - posted: How many of them were handed to the system.
    ///   - describe: The state the field must hold if exactly `n` units landed,
    ///     or nil when that is not a state worth describing.
    ///     `PartialWrite.overSelection`, bound to the plan. It is asked about
    ///     `units` itself as well, which is the write arriving in full after the
    ///     caller had given up on it.
    ///   - poll: The field, and the time budget to keep looking at it.
    public static func resolve(before: String, complete: String, units: Int, posted: Int,
                               describe: (Int) -> PartialWrite?, poll: SettlePoll) -> SettledWrite {
        // The most that can be in the field. Reaching it ends the settle early:
        // nothing further can arrive, so there is nothing left to wait for.
        // Zero posted is the one case that needs no window at all, because
        // nothing was queued: the first reading is already the final one.
        let most = max(0, min(posted, units))
        let terminal: String? = most <= 0 ? before
            : most >= units ? complete
            : describe(most)?.fieldText

        var text = poll.read() ?? ""
        while text != terminal, poll.keepWaiting() {
            text = poll.read() ?? ""
        }

        if text == complete { return .complete }

        // Checked before the hypotheses, because a replacement whose prefix is
        // the text it replaces produces a "partial" state indistinguishable
        // from the original one, and the original one is the truthful reading:
        // the user's text is all still there.
        if text == before {
            let pending = posted > 0 ? describe(min(posted, units)) : nil
            // A replacement whose prefix is the text it replaces would arrive
            // without changing a character, so there would be nothing to take
            // back out and no offer worth making.
            return .untouched(pending: pending?.fieldText == before ? nil : pending)
        }

        // The field is the evidence; the count was only a hint about when to
        // stop waiting. Whichever hypothesis matches, undoing it restores
        // `before`, which is the property that matters and the one
        // `PartialWriteTests` holds every case to.
        if units > 1 {
            for landed in 1..<units {
                if let partial = describe(landed), partial.fieldText == text {
                    return .half(partial)
                }
            }
        }

        return .unexplained(text)
    }
}
