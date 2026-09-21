namespace LexiconBar;

/// <summary>
/// One look at a field, and permission to look again.
///
/// The settle below has to re-read the field over a short window, which on
/// Windows means a cross-process UI Automation call and a sleep. Neither can
/// run on a headless box, so both sit behind this interface and the whole
/// decision stays testable: <c>KeystrokeSettleTests</c> scripts the readings a
/// field hands back and asserts what the engine concludes from them.
/// </summary>
public interface ISettlePoll
{
    /// <summary>The field's text now, or null when it cannot be read.</summary>
    string? Read();

    /// <summary>
    /// Waits a little and answers whether there is still time to look again.
    /// False ends the settle, and the last reading is the one acted on.
    /// </summary>
    bool KeepWaiting();
}

/// <summary>
/// What the field turned out to hold after synthesized keystrokes that did not
/// obviously work.
/// </summary>
public abstract record SettledWrite
{
    /// <summary>
    /// The whole replacement is in the field after all. The count
    /// <c>SendInput</c> reported was pessimistic, or the app was simply slow.
    /// </summary>
    public sealed record Complete : SettledWrite;

    /// <summary>
    /// The field holds a state <see cref="Partial"/> describes exactly: part of
    /// the replacement is in, and part of the user's own text is gone. The
    /// caller repairs it where it can and records the undo either way.
    /// </summary>
    public sealed record Half(PartialWrite Partial) : SettledWrite;

    /// <summary>
    /// The field still holds the text the plan was made from. Nothing of ours
    /// is in it and nothing of the user's is missing.
    /// </summary>
    /// <param name="Pending">
    /// What the field would hold if the keystrokes the system accepted turned
    /// up after the settle window closed, or null when nothing was accepted and
    /// so nothing can still be in flight.
    /// </param>
    public sealed record Untouched(PartialWrite? Pending) : SettledWrite;

    /// <summary>
    /// The field holds something no hypothesis explains. The engine stops here
    /// rather than write on top of a field it no longer understands.
    /// </summary>
    public sealed record Unexplained(string FieldText) : SettledWrite;
}

/// <summary>
/// Works out what a synthesized-keystroke write actually did, by watching the
/// field rather than by trusting the count <c>SendInput</c> handed back.
///
/// This exists because the first version of the partial-write recovery raced
/// the very keystrokes it was recovering from. It took a single immediate
/// reading of the field and demanded it equal the one state the arithmetic
/// predicted, while the success path beside it polled for 600 ms precisely
/// because the target app processes synthesized input on its own message loop.
/// <c>SendInput</c> only queues: its return value counts the records it
/// inserted, not the characters the app has consumed. So the single reading
/// found one of three things, and got two of them wrong:
///
/// <list type="bullet">
/// <item>nothing consumed yet, which read as "the field is unchanged", after
///   which the engine wrote the whole value and the queued characters landed on
///   top of it. The field was then corrupt and the undo entry, which claimed
///   the field held the spliced text, no longer matched it, so the offer was
///   withdrawn: corrupted text and no way back.</item>
/// <item>some consumed but not the number reported, which read as "landed
///   somewhere this cannot account for" and left exactly the state the recovery
///   was written to abolish: half a replacement in the field, the user's span
///   gone, nothing recorded, and a message saying the write had failed.</item>
/// <item>exactly the number reported, the only case the arithmetic's own tests
///   could reach, because they hand it a synthetic field.</item>
/// </list>
///
/// So the settle polls the way the success path polls, and it identifies the
/// state by what the field holds rather than by what the count claims. Every
/// hypothesis <see cref="PartialWrite"/> can produce undoes back to the same
/// original text, so matching the field against all of them and taking
/// whichever fits is safe, and is strictly better than answering "unexplained"
/// and leaving the user with no undo.
///
/// The count is still worth something: it bounds how much can possibly have
/// landed, which is what lets the settle stop early instead of always burning
/// the full window. A call cut between a key down and its key up still delivers
/// the character, because <c>KEYEVENTF_UNICODE</c> carries it on the down,
/// while <c>Keyboard.Deliver</c> rounds that pair down to "did not land", so the
/// true maximum is one unit above the reported count.
/// </summary>
public static class KeystrokeSettle
{
    /// <summary>
    /// Watches the field until it settles, and says what happened.
    /// </summary>
    /// <param name="before">The text the field held when the plan was made.</param>
    /// <param name="complete">The text it holds if all of the write landed.</param>
    /// <param name="units">
    /// How many units the write was: UTF-16 units for select-and-type, key
    /// events for backspace-and-retype.
    /// </param>
    /// <param name="reported">How many of them the system said it accepted.</param>
    /// <param name="describe">
    /// The state the field must hold if exactly <c>n</c> units landed, or null
    /// when that is not a state worth describing. <see cref="PartialWrite.OverSelection"/>
    /// or <see cref="PartialWrite.OverTail"/>, bound to the plan. It is asked
    /// about <paramref name="units"/> itself as well, which is the write
    /// arriving in full after the caller had given up on it.
    /// </param>
    /// <param name="poll">The field, and the time budget to keep looking at it.</param>
    public static SettledWrite Resolve(
        string before,
        string complete,
        int units,
        int reported,
        Func<int, PartialWrite?> describe,
        ISettlePoll poll)
    {
        ArgumentNullException.ThrowIfNull(before);
        ArgumentNullException.ThrowIfNull(complete);
        ArgumentNullException.ThrowIfNull(describe);
        ArgumentNullException.ThrowIfNull(poll);

        // The most that can be in the field, counting the down/up pair a cut
        // call may have half delivered. Reaching it ends the settle early:
        // nothing further can arrive, so there is nothing left to wait for.
        // Zero accepted is the one case that needs no window at all, because
        // nothing was queued: the first reading is already the final one.
        int most = Math.Clamp(reported <= 0 ? 0 : reported + 1, 0, units);
        string? terminal = most <= 0 ? before
            : most >= units ? complete
            : describe(most)?.FieldText;

        string text = poll.Read() ?? string.Empty;
        while (text != terminal && poll.KeepWaiting())
        {
            text = poll.Read() ?? string.Empty;
        }

        if (text == complete) return new SettledWrite.Complete();

        // Checked before the hypotheses, because a replacement whose prefix is
        // the text it replaces produces a "partial" state indistinguishable
        // from the original one, and the original one is the truthful reading:
        // the user's text is all still there.
        if (text == before)
        {
            PartialWrite? pending = reported > 0 ? describe(Math.Min(reported, units)) : null;

            // A replacement whose prefix is the text it replaces would arrive
            // without changing a character, so there would be nothing to take
            // back out and no offer worth making.
            return new SettledWrite.Untouched(pending?.FieldText == before ? null : pending);
        }

        // The field is the evidence; the count was only a hint about when to
        // stop waiting. Whichever hypothesis matches, undoing it restores
        // `before`, which is the property that matters and the one
        // PartialWriteTests holds every case to.
        for (int landed = 1; landed < units; landed++)
        {
            if (describe(landed) is PartialWrite partial && partial.FieldText == text)
            {
                return new SettledWrite.Half(partial);
            }
        }

        return new SettledWrite.Unexplained(text);
    }
}
