namespace LexiconBar;

/// <summary>
/// Remembers the last rewrite so the bubble's Undo (and Ctrl+Alt+Z) can put the
/// original text back — but only while the same field still holds exactly the
/// corrected text. The moment the user edits on, the offer goes away rather
/// than firing at a stale offset.
/// </summary>
public sealed class UndoLedger
{
    /// <param name="FieldKey">Opaque identity of the field (the caller decides what it is).</param>
    /// <param name="FieldTextAfter">Field value right after the rewrite.</param>
    public sealed record Entry(
        string FieldKey,
        TextSpan Span,
        string CorrectedText,
        string PreviousText,
        string FieldTextAfter)
    {
        /// <summary>The field value after undoing, when the field still holds the corrected text.</summary>
        public string? FieldTextBefore =>
            TextDiff.Splice(FieldTextAfter, new TextSpan(Span.Location, CorrectedText.Length), PreviousText);
    }

    public Entry? Last { get; private set; }

    public void Record(Entry entry) => Last = entry;

    /// <summary>True when <paramref name="fieldKey"/>/<paramref name="currentText"/> still match the last rewrite.</summary>
    public bool CanUndo(string fieldKey, string currentText) =>
        Last is { } last && last.FieldKey == fieldKey && last.FieldTextAfter == currentText;

    /// <summary>Consumes the entry if it still applies; null otherwise.</summary>
    public Entry? Take(string fieldKey, string currentText)
    {
        if (!CanUndo(fieldKey, currentText)) return null;
        Entry? entry = Last;
        Last = null;
        return entry;
    }

    public void Clear() => Last = null;
}
