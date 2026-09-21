namespace LexiconBar;

/// <summary>What the undo hotkey should do about the field it is pointed at.</summary>
public abstract record UndoDecision
{
    /// <summary>"Fix everywhere" is off. The field was not read.</summary>
    public sealed record Off : UndoDecision;

    /// <summary>
    /// The gate refused this field, so it was not read and must not be written
    /// to. The ledger has been cleared, because the entry in it held that
    /// field's text.
    /// </summary>
    public sealed record Refused(string Reason) : UndoDecision;

    /// <summary>
    /// No detector is following this field, so there is no correction of ours
    /// in it. Reached only after the gate has admitted the field.
    /// </summary>
    public sealed record NotWatching : UndoDecision;

    /// <summary>
    /// The field was read and holds <paramref name="CurrentText"/>, but no
    /// recorded rewrite still applies to it.
    /// </summary>
    public sealed record Nothing(string CurrentText) : UndoDecision;

    /// <summary>
    /// Write <paramref name="Plan"/> back into the field, which currently holds
    /// <paramref name="CurrentText"/>.
    /// </summary>
    public sealed record Go(RewritePlan Plan, string CurrentText) : UndoDecision;
}

/// <summary>
/// Everything the undo hotkey decides before it touches the field, which is all
/// of it except the keystrokes.
///
/// Undo reads the field and then writes into it, so it is a read like any other
/// and asks <see cref="ReadPolicy"/> first. It used to go straight to the
/// value, which made Ctrl+Alt+Z the one path where excluding an app while it
/// still held focus stopped neither the read nor the write, while every other
/// path in the engine refused it. macOS had the same hole in the same method.
///
/// That ordering is the whole reason this is a separate, portable class. Left
/// inside the engine it was three lines in a method that also drives UI
/// Automation and synthesizes keystrokes, so no headless runner could reach it
/// and nothing would have gone red if the two were swapped back. Here,
/// <c>UndoPlannerTests</c> drives it with a field that counts reads.
/// </summary>
public static class UndoPlanner
{
    /// <param name="policy">The master switch and the exclusion list, together.</param>
    /// <param name="field">The focused field. Asked for its value at most once, and only if admitted.</param>
    /// <param name="ledger">The last rewrite. Cleared here if the field turns out to be refused.</param>
    /// <param name="watching">Whether a detector is following this field.</param>
    /// <param name="limit">Read limit, as <see cref="IInspectableField.ReadValue"/> takes it.</param>
    public static UndoDecision Plan(
        ReadPolicy policy,
        IInspectableField field,
        UndoLedger ledger,
        bool watching,
        int limit)
    {
        ArgumentNullException.ThrowIfNull(policy);
        ArgumentNullException.ThrowIfNull(field);
        ArgumentNullException.ThrowIfNull(ledger);

        if (!policy.Enabled) return new UndoDecision.Off();

        // Before the read, and before anything below looks at the ledger. The
        // order is the point: a refusal that arrives while the field still has
        // focus has to stop the read, not merely the write that follows it.
        FieldRead read = policy.Read(field, limit);
        if (read.Refusal is string refusal)
        {
            // The entry describes that field and carries a span of its text, so
            // it goes with the refusal rather than waiting for the user to
            // focus somewhere else.
            ledger.Clear();
            return new UndoDecision.Refused(refusal);
        }

        if (!watching) return new UndoDecision.NotWatching();

        string current = read.Value ?? string.Empty;
        if (!ledger.CanUndo(field.Key, current)
            || ledger.Last is not UndoLedger.Entry entry
            || entry.FieldTextBefore is not string restored)
        {
            return new UndoDecision.Nothing(current);
        }

        // An undo is a rewrite with the two texts the other way round: the
        // correction is what is there now, and the user's own words are what
        // goes back in.
        return new UndoDecision.Go(
            new RewritePlan(
                new TextSpan(entry.Span.Location, entry.CorrectedText.Length),
                entry.CorrectedText,
                entry.PreviousText,
                restored),
            current);
    }
}
