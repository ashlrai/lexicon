using Xunit;

namespace LexiconBar.Tests;

/// <summary>
/// The arithmetic behind "the correction only half went in".
///
/// This is the one failure in the app that can destroy text the user wrote.
/// The keystroke write used to be a loop of <c>SendInput</c> calls, so a
/// correction over 200 characters was several of them; when a later call was
/// refused the earlier ones had already landed, the engine compared the field
/// against the value the plan was made from, found it different and told the
/// user the write had failed. The field held half a replacement, the original
/// span was gone and nothing had been recorded that could put it back.
///
/// The write is one call now, and what a short call left behind is computed
/// here. Every case below asserts the same two things: the field text the
/// engine will check its read against, and that undoing the entry restores
/// exactly what the user had. The second is the one that matters.
/// </summary>
public class PartialWriteTests
{
    private const string Key = "field-1";

    /// <summary>"I use ashler daily" with "ashler" becoming "Ashlr.AI".</summary>
    private static RewritePlan MidFieldPlan() => Plan(
        before: "I use ashler daily",
        span: new TextSpan(6, 6),
        replacement: "Ashlr.AI");

    /// <summary>The same correction sitting at the very end of the field.</summary>
    private static RewritePlan TailPlan() => Plan(
        before: "I use ashler",
        span: new TextSpan(6, 6),
        replacement: "Ashlr.AI");

    private static RewritePlan Plan(string before, TextSpan span, string replacement)
    {
        string previous = TextDiff.Substring(before, span)!;
        string spliced = TextDiff.Splice(before, span, replacement)!;
        return new RewritePlan(span, previous, replacement, spliced);
    }

    // ------------------------------------------------------- select and type

    [Fact]
    public void HalfATypedReplacementIsDescribedAndUndoable()
    {
        const string before = "I use ashler daily";
        RewritePlan plan = MidFieldPlan();

        // "Ashl" of "Ashlr.AI" landed; the selected "ashler" is already gone.
        PartialWrite partial = PartialWrite.OverSelection(plan, before, 4)!;

        Assert.Equal("I use Ashl daily", partial.FieldText);
        Assert.Equal("Ashl", partial.WrittenText);
        Assert.Equal("ashler", partial.OriginalText);
        Assert.Equal(before, partial.Undone);
    }

    [Fact]
    public void TheEntryPutsTheUsersOwnTextBack()
    {
        const string before = "I use ashler daily";
        PartialWrite partial = PartialWrite.OverSelection(MidFieldPlan(), before, 4)!;

        UndoLedger.Entry entry = partial.Entry(Key);
        Assert.Equal(Key, entry.FieldKey);
        Assert.Equal(partial.FieldText, entry.FieldTextAfter);
        Assert.Equal(before, entry.FieldTextBefore);

        // And the ledger will actually offer it: the field holds exactly what
        // the entry says it does.
        UndoLedger ledger = new();
        ledger.Record(entry);
        Assert.True(ledger.CanUndo(Key, partial.FieldText));
    }

    [Fact]
    public void OneUnitIsStillAPartialWrite()
    {
        PartialWrite partial = PartialWrite.OverSelection(MidFieldPlan(), "I use ashler daily", 1)!;

        Assert.Equal("I use A daily", partial.FieldText);
        Assert.Equal("I use ashler daily", partial.Undone);
    }

    [Fact]
    public void NothingTypedIsNotAPartialWrite()
    {
        // A selection that was never typed over still holds the user's text.
        Assert.Null(PartialWrite.OverSelection(MidFieldPlan(), "I use ashler daily", 0));
        Assert.Null(PartialWrite.OverSelection(MidFieldPlan(), "I use ashler daily", -3));
    }

    [Fact]
    public void AFullyTypedReplacementIsNotAPartialWrite()
    {
        RewritePlan plan = MidFieldPlan();
        Assert.Null(PartialWrite.OverSelection(plan, "I use ashler daily", plan.NewText.Length));
        Assert.Null(PartialWrite.OverSelection(plan, "I use ashler daily", plan.NewText.Length + 5));
    }

    [Fact]
    public void AFieldThatNoLongerHoldsThePlansSpanIsRefused()
    {
        // The premise is already false, so there is no state to describe and
        // the engine must leave the field alone rather than guess at one.
        Assert.Null(PartialWrite.OverSelection(MidFieldPlan(), "I use something else", 4));
        Assert.Null(PartialWrite.OverSelection(MidFieldPlan(), "short", 4));
    }

    // ---------------------------------------------------- backspace and type

    [Fact]
    public void BackspacesThatLandedWithoutTheirRetypeAreRecorded()
    {
        const string before = "I use ashler";
        RewritePlan plan = TailPlan();

        // Six key events: every backspace, none of the replacement. This is the
        // state the old two-call form could leave behind unconditionally.
        PartialWrite partial = PartialWrite.OverTail(plan, before, 6)!;

        Assert.Equal("I use ", partial.FieldText);
        Assert.Equal(string.Empty, partial.WrittenText);
        Assert.Equal("ashler", partial.OriginalText);
        Assert.Equal(before, partial.Undone);
        Assert.Equal(before, partial.Entry(Key).FieldTextBefore);
    }

    [Fact]
    public void SomeBackspacesAndSomeRetypeAreRecorded()
    {
        const string before = "I use ashler";
        RewritePlan plan = TailPlan();

        // Nine events: six backspaces, then "Ash".
        PartialWrite partial = PartialWrite.OverTail(plan, before, 9)!;

        Assert.Equal("I use Ash", partial.FieldText);
        Assert.Equal("Ash", partial.WrittenText);
        Assert.Equal("ashler", partial.OriginalText);
        Assert.Equal(before, partial.Undone);
    }

    [Fact]
    public void PartOfTheBackspacesIsRecorded()
    {
        const string before = "I use ashler";

        // Two events: two backspaces, nothing typed. Only "er" is gone.
        PartialWrite partial = PartialWrite.OverTail(TailPlan(), before, 2)!;

        Assert.Equal("I use ashl", partial.FieldText);
        Assert.Equal("er", partial.OriginalText);
        Assert.Equal(string.Empty, partial.WrittenText);
        Assert.Equal(before, partial.Undone);
    }

    [Fact]
    public void AllTheEventsOrNoneIsNotAPartialWrite()
    {
        RewritePlan plan = TailPlan();
        int events = plan.PreviousText.Length + plan.NewText.Length;

        Assert.Null(PartialWrite.OverTail(plan, "I use ashler", 0));
        Assert.Null(PartialWrite.OverTail(plan, "I use ashler", events));
        Assert.Null(PartialWrite.OverTail(plan, "I use ashler", events + 1));
    }

    [Fact]
    public void TheTailPathRefusesAPlanThatIsNotTheTail()
    {
        // The backspace strategy only runs on the tail of the field. Anywhere
        // else the backspaces do not eat the plan's span, so the arithmetic
        // here would be a fiction.
        Assert.Null(PartialWrite.OverTail(MidFieldPlan(), "I use ashler daily", 6));
    }

    [Fact]
    public void EveryTailProgressRoundTripsBackToTheOriginal()
    {
        const string before = "I use ashler";
        RewritePlan plan = TailPlan();
        int events = plan.PreviousText.Length + plan.NewText.Length;

        for (int delivered = 1; delivered < events; delivered++)
        {
            PartialWrite partial = PartialWrite.OverTail(plan, before, delivered)!;
            Assert.Equal(before, partial.Undone);
            Assert.Equal(before, partial.Entry(Key).FieldTextBefore);
        }
    }

    [Fact]
    public void EverySelectionProgressRoundTripsBackToTheOriginal()
    {
        const string before = "I use ashler daily";
        RewritePlan plan = MidFieldPlan();

        for (int typed = 1; typed < plan.NewText.Length; typed++)
        {
            PartialWrite partial = PartialWrite.OverSelection(plan, before, typed)!;
            Assert.Equal(before, partial.Undone);
            Assert.Equal(before, partial.Entry(Key).FieldTextBefore);
        }
    }
}
