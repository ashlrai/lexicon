namespace LexiconBar;

/// <summary>A button on the correction bubble.</summary>
public enum BubbleAction
{
    /// <summary>Put the dictated text back (the same thing Ctrl+Alt+Z does).</summary>
    Undo,

    /// <summary>"that word was right": records the original under the term's <c>never</c> list and undoes.</summary>
    Never,

    /// <summary>
    /// "that guess was right": promotes the original to an explicit alias. Only
    /// offered when the rewrite came from a phonetic or fuzzy guess — an exact
    /// alias is already explicit, so there is nothing to add.
    /// </summary>
    Add,
}

/// <summary>
/// One <c>original → canonical</c> row. The view draws <see cref="Original"/>
/// struck through and <see cref="Canonical"/> bold; keeping them apart is what
/// makes that testable.
/// </summary>
public sealed record BubbleLine(string Original, string Canonical, string? Reason = null)
{
    /// <summary>Plain-text form, for logs, tooltips and the accessibility name.</summary>
    public string Label => $"{Original} → {Canonical}";
}

/// <summary>Everything the bubble window needs to render one correction event.</summary>
/// <param name="Lines">At most <c>maxLines</c> rows, in the order the API reported them.</param>
/// <param name="Overflow">"+4 more" when replacements were dropped, null when they all fit.</param>
/// <param name="Actions">Which buttons to show, in display order.</param>
/// <param name="Target">The replacement Never and Add act on: the first guessed one if there is one, else the first.</param>
/// <param name="Total">Total replacement count, including the ones past <c>maxLines</c>.</param>
public sealed record BubbleContent(
    IReadOnlyList<BubbleLine> Lines,
    string? Overflow,
    IReadOnlyList<BubbleAction> Actions,
    BubbleLine Target,
    int Total)
{
    /// <summary>"Fixed 1 word" / "Fixed 3 words".</summary>
    public string Title => Total == 1 ? "Fixed 1 word" : $"Fixed {Total} words";

    /// <summary>One line for Narrator and for the balloon-tip fallback.</summary>
    public string AccessibilityLabel
    {
        get
        {
            List<string> parts = new() { Title };
            parts.AddRange(Lines.Select(line => line.Label));
            if (Overflow is not null) parts.Add(Overflow);
            return string.Join(", ", parts);
        }
    }
}

public static class CorrectionBubble
{
    /// <summary>How many rows fit before the bubble starts counting instead.</summary>
    public const int MaxLines = 3;

    /// <summary>
    /// True for the reasons that mean "the matcher guessed": those are the ones
    /// worth promoting to an explicit alias with <c>POST /learn</c>. A missing
    /// reason counts as not-a-guess, so Add stays hidden rather than offering to
    /// learn something that may already be exact.
    /// </summary>
    public static bool IsGuess(string? reason)
    {
        if (reason is null) return false;
        string lowered = reason.ToLowerInvariant();
        return lowered.Contains("phonetic", StringComparison.Ordinal)
               || lowered.Contains("fuzzy", StringComparison.Ordinal);
    }

    /// <summary>Null when there is nothing to show (no replacements).</summary>
    public static BubbleContent? Content(IReadOnlyList<FixReplacement> replacements, int maxLines = MaxLines)
    {
        List<BubbleLine> all = replacements
            .Select(r => new BubbleLine(r.Original, r.Replacement, r.Reason))
            .ToList();
        if (all.Count == 0) return null;

        int limit = Math.Max(1, maxLines);
        List<BubbleLine> shown = all.Take(limit).ToList();
        int dropped = all.Count - shown.Count;
        BubbleLine target = all.FirstOrDefault(line => IsGuess(line.Reason)) ?? all[0];
        return new BubbleContent(
            shown,
            dropped > 0 ? $"+{dropped} more" : null,
            Actions(replacements),
            target,
            all.Count);
    }

    /// <summary>
    /// Undo and Never are always available; Add only when at least one
    /// replacement came from a phonetic or fuzzy guess.
    /// </summary>
    public static IReadOnlyList<BubbleAction> Actions(IReadOnlyList<FixReplacement> replacements)
    {
        List<BubbleAction> actions = new() { BubbleAction.Undo, BubbleAction.Never };
        if (replacements.Any(r => IsGuess(r.Reason))) actions.Add(BubbleAction.Add);
        return actions;
    }
}
