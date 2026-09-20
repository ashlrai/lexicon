namespace LexiconBar;

/// <summary>Why a burst was not rewritten after the API answered.</summary>
public enum RewriteRefusal
{
    None = 0,
    Unchanged,
    FieldChanged,
    FieldTooLong,
    MultiParagraph,
    ReplacementOutsideBurst,
    RangeOutOfBounds,
}

/// <summary>The write the engine is about to perform.</summary>
/// <param name="Span">Range of the burst inside the field, UTF-16.</param>
/// <param name="SplicedFullText">Whole field value after the splice, for the value-write fallback and for verification.</param>
public sealed record RewritePlan(TextSpan Span, string PreviousText, string NewText, string SplicedFullText)
{
    /// <summary>Where the caret goes afterwards: end of the replaced span.</summary>
    public TextSpan Caret => new(Span.Location + NewText.Length, 0);
}

public sealed record RewriteDecision(RewritePlan? Plan, RewriteRefusal Refusal)
{
    public bool Ok => Plan is not null;

    public static RewriteDecision Success(RewritePlan plan) => new(plan, RewriteRefusal.None);

    public static RewriteDecision Refused(RewriteRefusal refusal) => new(null, refusal);
}

/// <summary>
/// The safety checks between "the API changed the burst" and "write it into the
/// field", and the resulting write plan. Pure, so it is testable without a
/// Windows box — which matters, because every one of these guards exists
/// because its absence once ate a sentence of somebody's writing.
/// </summary>
public static class RewritePlanner
{
    public static RewriteDecision Make(
        Burst burst,
        NormalizeResponse response,
        string currentFieldText,
        int maxFieldLength = 20_000)
    {
        if (!response.Changed || response.Output == burst.Text) return RewriteDecision.Refused(RewriteRefusal.Unchanged);

        // The field has been live the whole time the API was answering. If it
        // no longer holds exactly the snapshot the burst was cut from, every
        // offset we have is stale and the only safe move is to do nothing.
        if (currentFieldText != burst.FullText) return RewriteDecision.Refused(RewriteRefusal.FieldChanged);
        if (currentFieldText.Length > maxFieldLength) return RewriteDecision.Refused(RewriteRefusal.FieldTooLong);
        if (BurstDetector.IsMultiParagraph(burst.Text)) return RewriteDecision.Refused(RewriteRefusal.MultiParagraph);

        // A newline the burst did not have would be typed as Return by the
        // keystroke strategy, which in a chat composer sends the message.
        if (TextDiff.ContainsNewline(response.Output) && !TextDiff.ContainsNewline(burst.Text))
        {
            return RewriteDecision.Refused(RewriteRefusal.MultiParagraph);
        }

        int burstLength = burst.Text.Length;
        foreach (FixReplacement replacement in response.Replacements)
        {
            if (replacement.Start < 0 || replacement.End > burstLength || replacement.End < replacement.Start)
            {
                return RewriteDecision.Refused(RewriteRefusal.ReplacementOutsideBurst);
            }
        }

        if (TextDiff.Substring(currentFieldText, burst.Span) != burst.Text
            || TextDiff.Splice(currentFieldText, burst.Span, response.Output) is not string spliced)
        {
            return RewriteDecision.Refused(RewriteRefusal.RangeOutOfBounds);
        }

        return RewriteDecision.Success(new RewritePlan(burst.Span, burst.Text, response.Output, spliced));
    }
}
