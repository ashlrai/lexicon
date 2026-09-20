using Xunit;

namespace LexiconBar.Tests;

/// <summary>
/// Regression tests for the one failure that matters most: a rewrite landing on
/// the wrong span and mangling text the user had already written.
///
/// Seen live in TextEdit on macOS, and there is no reason Notepad would behave
/// differently. The document held
///   "ping Ashlr.AI about the cooper netties rollout"
/// and a dictation burst, "ping ashler about the cuban eats rollout on versal",
/// arrived in front of it. Both start "ping ", so the prefix/suffix diff
/// attributed those five units to the old text and reported the insertion five
/// units late — a window running from inside the new text into the old. The
/// window was textually consistent, so every downstream guard passed, and the
/// correction was spliced into the middle of a word while the words that fell
/// outside the slid window ("ashler", "versal") were never corrected at all.
///
/// A port of <c>Tests/LexiconBarKitTests/BurstAlignmentTests.swift</c>.
/// </summary>
public class BurstAlignmentTests
{
    private const string Existing = "ping Ashlr.AI about the cooper netties rollout";
    private const string Pasted = "ping ashler about the cuban eats rollout on versal";

    // ---------------------------------------------------------------- caret

    [Fact]
    public void InsertionInFrontOfTextThatStartsTheSameWayIsAmbiguous()
    {
        string after = Pasted + Existing;
        TextDiff.Delta delta = TextDiff.ComputeDelta(Existing, after);
        // The naive window starts after the shared "ping ".
        Assert.Equal(5, delta.Location);
        Assert.Equal(Pasted.Length, delta.Inserted);
        Assert.Equal(0, delta.Removed);
        // ...and could just as well have started anywhere in 0...5.
        Assert.Equal(5, delta.SlideLeft);
        Assert.Equal(0, delta.SlideRight);
        Assert.False(delta.Anchored);
        Assert.True(delta.IsAmbiguous);
        // The slid window is not what arrived: it ends with the old text's "ping ".
        Assert.Equal(
            "ashler about the cuban eats rollout on versalping ",
            TextDiff.Substring(after, delta.InsertedSpan));
    }

    [Fact]
    public void CaretPinsTheInsertionToWhatActuallyArrived()
    {
        string after = Pasted + Existing;
        TextDiff.Delta delta = TextDiff.ComputeDelta(Existing, after, Pasted.Length);
        Assert.Equal(0, delta.Location);
        Assert.Equal(Pasted.Length, delta.Inserted);
        Assert.True(delta.Anchored);
        Assert.False(delta.IsAmbiguous);
        Assert.Equal(Pasted, TextDiff.Substring(after, delta.InsertedSpan));
    }

    [Fact]
    public void CaretOutsideThePlayIsNotBelieved()
    {
        string after = Pasted + Existing;
        // A caret that cannot have produced this text (the user moved it, or
        // the app answered stale) leaves the window a guess, not an anchor.
        TextDiff.Delta delta = TextDiff.ComputeDelta(Existing, after, 3);
        Assert.False(delta.Anchored);
        Assert.True(delta.IsAmbiguous);
    }

    [Fact]
    public void OrdinaryInsertionIsNotAmbiguous()
    {
        TextDiff.Delta a = TextDiff.ComputeDelta(string.Empty, Pasted);
        Assert.Equal(0, a.Location);
        Assert.False(a.IsAmbiguous);

        TextDiff.Delta b = TextDiff.ComputeDelta("Hi. ", "Hi. " + Pasted);
        Assert.Equal(4, b.Location);
        Assert.Equal(0, b.SlideLeft);
        Assert.Equal(0, b.SlideRight);
        Assert.False(b.IsAmbiguous);
    }

    [Fact]
    public void SlideRightIsMeasuredToo()
    {
        // "ab" inserted in front of "ab" can be the first or the second copy.
        TextDiff.Delta delta = TextDiff.ComputeDelta("abc", "ababc");
        Assert.Equal(2, delta.Inserted);
        Assert.True(delta.IsAmbiguous);
        Assert.Equal(2, delta.SlideLeft + delta.SlideRight);
        // The caret resolves it: ending at 2 means the leading copy arrived.
        TextDiff.Delta anchored = TextDiff.ComputeDelta("abc", "ababc", 2);
        Assert.Equal(0, anchored.Location);
        Assert.True(anchored.Anchored);
    }

    [Fact]
    public void ReplacementReportsNoPlay()
    {
        TextDiff.Delta delta = TextDiff.ComputeDelta("ping ashler", "ping Ashlr.AI");
        Assert.Equal(6, delta.Removed);
        Assert.Equal(0, delta.SlideLeft);
        Assert.Equal(0, delta.SlideRight);
        Assert.False(delta.IsAmbiguous);
    }

    // ------------------------------------------------------------- detector

    [Fact]
    public void BurstInFrontOfExistingTextIsSkippedWithoutACaret()
    {
        BurstDetector d = new(Existing);
        d.Record(Pasted + Existing, 1.0);
        SettleOutcome.Skipped skipped = Assert.IsType<SettleOutcome.Skipped>(d.Settle(1.8));
        Assert.StartsWith("insertion point is ambiguous", skipped.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void BurstInFrontOfExistingTextFiresOnTheRightSpanWithACaret()
    {
        BurstDetector d = new(Existing);
        string after = Pasted + Existing;
        d.Record(after, 1.0);
        SettleOutcome.Fired fired = Assert.IsType<SettleOutcome.Fired>(d.Settle(1.8, Pasted.Length));
        Burst burst = fired.Burst;
        Assert.Equal(new TextSpan(0, Pasted.Length), burst.Span);
        Assert.Equal(Pasted, burst.Text);
        Assert.Equal(after, burst.FullText);
        // The burst is exactly the span it claims to be.
        Assert.Equal(burst.Text, TextDiff.Substring(burst.FullText, burst.Span));
    }

    [Fact]
    public void BurstBetweenTwoSentencesFiresOnTheRightSpan()
    {
        const string before = "Morning. ";
        const string tail = " Thanks.";
        BurstDetector d = new(before + tail);
        string after = before + Pasted + tail;
        d.Record(after, 1.0);
        SettleOutcome.Fired fired = Assert.IsType<SettleOutcome.Fired>(d.Settle(1.8, (before + Pasted).Length));
        Assert.Equal(new TextSpan(before.Length, Pasted.Length), fired.Burst.Span);
        Assert.Equal(Pasted, fired.Burst.Text);
    }

    // --------------------------------------------------------------- splice

    /// <summary>
    /// Several corrections in one burst, with the user's own text on both sides.
    /// The whole burst is replaced in a single splice, so no correction can
    /// shift another one out of position.
    /// </summary>
    [Fact]
    public void MultipleReplacementsInOneBurstLandTogether()
    {
        const string before = "Note: ";
        const string tail = " Thanks.";
        const string output = "ping Ashlr.AI about the Kubernetes rollout on Vercel";
        string full = before + Pasted + tail;
        Burst burst = new(new TextSpan(before.Length, Pasted.Length), Pasted, full);
        NormalizeResponse response = new(
            Input: Pasted,
            Output: output,
            Changed: true,
            Replacements: new[]
            {
                new FixReplacement(5, 11, "ashler", "Ashlr.AI"),
                new FixReplacement(22, 32, "cuban eats", "Kubernetes"),
                new FixReplacement(44, 50, "versal", "Vercel"),
            },
            Summary: "3 corrections");

        RewriteDecision decision = RewritePlanner.Make(burst, response, full);
        RewritePlan plan = Assert.IsType<RewritePlan>(decision.Plan);
        Assert.Equal(burst.Span, plan.Span);
        Assert.Equal(Pasted, plan.PreviousText);
        Assert.Equal(output, plan.NewText);
        Assert.Equal(before + output + tail, plan.SplicedFullText);
        // Nothing of the user's own text was touched.
        Assert.StartsWith(before, plan.SplicedFullText, StringComparison.Ordinal);
        Assert.EndsWith(tail, plan.SplicedFullText, StringComparison.Ordinal);
        // The caret lands after the corrected span, not after the original.
        Assert.Equal(new TextSpan(before.Length + output.Length, 0), plan.Caret);
        // And the plan is self-consistent.
        Assert.Equal(plan.SplicedFullText, TextDiff.Splice(full, plan.Span, plan.NewText));
    }

    [Fact]
    public void StaleSnapshotIsRefused()
    {
        string full = "Note: " + Pasted;
        Burst burst = new(new TextSpan(6, Pasted.Length), Pasted, full);
        NormalizeResponse response = new(
            Pasted, "ping Ashlr.AI about the Kubernetes rollout on Vercel", true,
            Array.Empty<FixReplacement>(), "2 corrections");

        // The user typed one more character while the API was answering.
        Assert.Equal(RewriteRefusal.FieldChanged, RewritePlanner.Make(burst, response, full + "!").Refusal);
        Assert.Equal(RewriteRefusal.FieldChanged, RewritePlanner.Make(burst, response, "something else entirely").Refusal);
    }

    [Fact]
    public void BurstRangeThatNoLongerHoldsTheBurstTextIsRefused()
    {
        // Same text length, wrong offset: the guard is on the content of the
        // span, not just on its bounds.
        string full = "Note: " + Pasted;
        Burst burst = new(new TextSpan(5, Pasted.Length), Pasted, full);
        NormalizeResponse response = new(
            Pasted, "ping Ashlr.AI about the Kubernetes rollout on Vercel", true,
            Array.Empty<FixReplacement>(), "2 corrections");
        Assert.Equal(RewriteRefusal.RangeOutOfBounds, RewritePlanner.Make(burst, response, full).Refusal);
    }

    [Fact]
    public void ARewriteThatWouldIntroduceANewlineIsRefused()
    {
        // In a chat composer a synthesized Return sends the message.
        string full = Pasted;
        Burst burst = new(new TextSpan(0, Pasted.Length), Pasted, full);
        NormalizeResponse response = new(Pasted, "ping Ashlr.AI\nabout the rollout", true,
            Array.Empty<FixReplacement>(), "1 correction");
        Assert.Equal(RewriteRefusal.MultiParagraph, RewritePlanner.Make(burst, response, full).Refusal);
    }

    [Fact]
    public void AReplacementOutsideTheBurstIsRefused()
    {
        string full = Pasted;
        Burst burst = new(new TextSpan(0, Pasted.Length), Pasted, full);
        NormalizeResponse response = new(
            Pasted, "ping Ashlr.AI about the rollout", true,
            new[] { new FixReplacement(5, Pasted.Length + 4, "ashler", "Ashlr.AI") },
            "1 correction");
        Assert.Equal(RewriteRefusal.ReplacementOutsideBurst, RewritePlanner.Make(burst, response, full).Refusal);
    }

    [Fact]
    public void AnUnchangedResponseIsNotWritten()
    {
        string full = Pasted;
        Burst burst = new(new TextSpan(0, Pasted.Length), Pasted, full);
        Assert.Equal(
            RewriteRefusal.Unchanged,
            RewritePlanner.Make(burst, new NormalizeResponse(Pasted, Pasted, false, Array.Empty<FixReplacement>(), string.Empty), full).Refusal);
        // `changed: true` but an identical output is still nothing to write.
        Assert.Equal(
            RewriteRefusal.Unchanged,
            RewritePlanner.Make(burst, new NormalizeResponse(Pasted, Pasted, true, Array.Empty<FixReplacement>(), string.Empty), full).Refusal);
    }

    [Fact]
    public void UndoPutsBackExactlyWhatWasThere()
    {
        const string before = "Note: ";
        const string tail = " Thanks.";
        const string output = "ping Ashlr.AI about the Kubernetes rollout on Vercel";
        UndoLedger.Entry entry = new(
            FieldKey: "1:2",
            Span: new TextSpan(before.Length, Pasted.Length),
            CorrectedText: output,
            PreviousText: Pasted,
            FieldTextAfter: before + output + tail);
        Assert.Equal(before + Pasted + tail, entry.FieldTextBefore);
    }

    [Fact]
    public void UndoIsOnlyOfferedWhileTheFieldStillHoldsTheCorrection()
    {
        UndoLedger ledger = new();
        UndoLedger.Entry entry = new("1:2", new TextSpan(0, 5), "Ashlr", "ashler", "Ashlr rules");
        ledger.Record(entry);
        Assert.True(ledger.CanUndo("1:2", "Ashlr rules"));
        Assert.False(ledger.CanUndo("1:2", "Ashlr rules!"));
        Assert.False(ledger.CanUndo("9:9", "Ashlr rules"));
        Assert.Null(ledger.Take("1:2", "Ashlr rules!"));
        Assert.Equal(entry, ledger.Take("1:2", "Ashlr rules"));
        // Consumed: a second undo is not offered.
        Assert.Null(ledger.Take("1:2", "Ashlr rules"));
    }
}
