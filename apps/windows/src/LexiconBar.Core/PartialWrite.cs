namespace LexiconBar;

/// <summary>
/// What a synthesized-keystroke write left in the field when only part of it
/// landed, and the ledger entry that takes it back out again.
///
/// The keystroke path is the only write in this app that can half-finish.
/// <c>SendInput</c> reports how many events it accepted and it may accept fewer
/// than it was handed: UIPI blocks input to an elevated window, and the target
/// can be torn down mid-call. The engine used to treat anything short of
/// complete success as "nothing happened", fall through to the next strategy,
/// find the field no longer held what the plan was made from and report that
/// the write had failed. All three of those sentences were wrong at once: the
/// field held half a replacement, the user's original span was already gone,
/// and no undo had been recorded. Corrupting text the user wrote is the worst
/// thing this app can do, so the arithmetic that says exactly what the field
/// must hold lives here, in the portable half, where it is tested.
///
/// It is a hypothesis rather than a fact. The caller re-reads the field and
/// acts on this only when <see cref="FieldText"/> matches what it finds; a
/// field holding anything else is one the engine no longer understands, and it
/// says so instead of guessing an offset to splice at.
/// </summary>
/// <param name="FieldText">What the field must hold if exactly this much landed.</param>
/// <param name="Span">The span of the user's own text that the partial write overwrote or deleted.</param>
/// <param name="WrittenText">The leading part of the replacement that did land.</param>
/// <param name="OriginalText">The user's text that the partial write consumed.</param>
public sealed record PartialWrite(string FieldText, TextSpan Span, string WrittenText, string OriginalText)
{
    /// <summary>
    /// The field's text with the partial write taken back out, which is what it
    /// held before. Null when the splice no longer fits, which is the same
    /// "leave it alone" answer <see cref="TextDiff.Splice"/> gives everywhere else.
    /// </summary>
    public string? Undone =>
        TextDiff.Splice(FieldText, new TextSpan(Span.Location, WrittenText.Length), OriginalText);

    /// <summary>The ledger entry whose undo puts <see cref="OriginalText"/> back.</summary>
    public UndoLedger.Entry Entry(string fieldKey) =>
        new(fieldKey, Span, WrittenText, OriginalText, FieldText);

    /// <summary>
    /// A select-and-type write in which the first <paramref name="unitsTyped"/>
    /// UTF-16 units of the replacement landed over the selected span and the
    /// rest did not.
    ///
    /// Null when this is not a partial write at all: zero units typed leaves a
    /// selection intact and destroys nothing, and a full count is simply the
    /// write working. Null too when <paramref name="before"/> does not hold the
    /// plan's span, because then the premise is already false.
    /// </summary>
    public static PartialWrite? OverSelection(RewritePlan plan, string before, int unitsTyped)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(before);

        if (unitsTyped <= 0 || unitsTyped >= plan.NewText.Length) return null;
        if (TextDiff.Substring(before, plan.Span) != plan.PreviousText) return null;

        string written = plan.NewText[..unitsTyped];
        if (TextDiff.Splice(before, plan.Span, written) is not string fieldText) return null;

        return new PartialWrite(fieldText, plan.Span, written, plan.PreviousText);
    }

    /// <summary>
    /// A backspace-and-retype write that stopped after
    /// <paramref name="keyEventsDelivered"/> of its
    /// <c>PreviousText.Length + NewText.Length</c> key events.
    ///
    /// The backspaces go first, so a write that stops early may have deleted
    /// part or all of the span and typed none or some of the replacement. That
    /// ordering is why this path is the one that most needed a record: every
    /// event it gets through destroys a character before any of them puts one
    /// back.
    ///
    /// Null when this is not a partial write, or when the plan is not the
    /// tail-of-the-field shape the path requires, which is the only shape in
    /// which a backspace can be known to eat the plan's own span and nothing else.
    /// </summary>
    public static PartialWrite? OverTail(RewritePlan plan, string before, int keyEventsDelivered)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(before);

        int events = plan.PreviousText.Length + plan.NewText.Length;
        if (keyEventsDelivered <= 0 || keyEventsDelivered >= events) return null;
        if (plan.Span.End != before.Length) return null;
        if (TextDiff.Substring(before, plan.Span) != plan.PreviousText) return null;

        int deleted = Math.Min(keyEventsDelivered, plan.PreviousText.Length);
        int typed = Math.Max(0, keyEventsDelivered - plan.PreviousText.Length);

        int location = before.Length - deleted;
        string original = before[location..];
        string written = plan.NewText[..typed];

        return new PartialWrite(
            FieldText: string.Concat(before.AsSpan(0, location), written),
            Span: new TextSpan(location, original.Length),
            WrittenText: written,
            OriginalText: original);
    }
}
