using Xunit;

namespace LexiconBar.Tests;

/// <summary>
/// What the engine concludes about a synthesized write that did not obviously
/// work, from the readings the field hands back.
///
/// <see cref="PartialWriteTests"/> covers the arithmetic: given that exactly
/// this much landed, here is the field and here is the undo. It could only ever
/// cover that, because it hands the arithmetic a synthetic field and asks it a
/// question it has already answered. The first partial-write recovery shipped
/// green on exactly those tests while racing the keystrokes it was recovering
/// from: it took one immediate reading of a field whose app had not yet
/// processed the input, concluded from the single state the arithmetic
/// predicted, and got the two most likely outcomes wrong.
///
/// So these tests are about time and evidence rather than about arithmetic.
/// They script the readings a field returns while the app catches up, and hold
/// the settle to three properties:
///
/// <list type="bullet">
/// <item>a field that has not caught up yet is not a field that ignored us;</item>
/// <item>whatever it settles on, the recorded undo puts back exactly the text
///   the user had;</item>
/// <item>keystrokes the system accepted but never showed are never written over.</item>
/// </list>
/// </summary>
public class KeystrokeSettleTests
{
    private const string Before = "I use ashler daily";
    private const string Key = "field-1";

    /// <summary>"I use ashler daily" with "ashler" becoming "Ashlr.AI".</summary>
    private static RewritePlan MidFieldPlan() => Plan(Before, new TextSpan(6, 6), "Ashlr.AI");

    /// <summary>The same correction at the very end, which the tail path needs.</summary>
    private static RewritePlan TailPlan() => Plan("I use ashler", new TextSpan(6, 6), "Ashlr.AI");

    private static RewritePlan Plan(string before, TextSpan span, string replacement)
    {
        string previous = TextDiff.Substring(before, span)!;
        string spliced = TextDiff.Splice(before, span, replacement)!;
        return new RewritePlan(span, previous, replacement, spliced);
    }

    /// <summary>The whole correction, as the engine describes it to the settle.</summary>
    private static PartialWrite Full(RewritePlan plan) =>
        new(plan.SplicedFullText, plan.Span, plan.NewText, plan.PreviousText);

    private static Func<int, PartialWrite?> OverSelection(RewritePlan plan, string before) =>
        landed => landed >= plan.NewText.Length
            ? Full(plan)
            : PartialWrite.OverSelection(plan, before, landed);

    private static Func<int, PartialWrite?> OverTail(RewritePlan plan, string before, int events) =>
        landed => landed >= events ? Full(plan) : PartialWrite.OverTail(plan, before, landed);

    /// <summary>
    /// A field that answers a scripted sequence of readings, then repeats the
    /// last one, and a budget of one wait per scripted reading after the first.
    /// The stand-in for an app processing synthesized input on its own message
    /// loop, which is the thing the real settle is waiting for and the thing a
    /// single read cannot see.
    /// </summary>
    private sealed class ScriptedField : ISettlePoll
    {
        private readonly string[] _readings;
        private int _at;

        internal ScriptedField(params string[] readings) => _readings = readings;

        /// <summary>How many times the settle looked.</summary>
        internal int Reads { get; private set; }

        /// <summary>How many times it chose to wait rather than decide.</summary>
        internal int Waits { get; private set; }

        public string? Read()
        {
            Reads += 1;
            return _readings[Math.Min(_at, _readings.Length - 1)];
        }

        public bool KeepWaiting()
        {
            if (_at >= _readings.Length - 1) return false;
            _at += 1;
            Waits += 1;
            return true;
        }
    }

    private static SettledWrite Resolve(RewritePlan plan, string before, int reported, ScriptedField field) =>
        KeystrokeSettle.Resolve(
            before, plan.SplicedFullText, plan.NewText.Length, reported, OverSelection(plan, before), field);

    // ------------------------------------------- the app has not caught up yet

    /// <summary>
    /// The first failure the single read produced: the app had consumed nothing
    /// when it looked, so the engine called the field unchanged, wrote the whole
    /// value, and the queued characters landed on top of it. The field was then
    /// corrupt and the undo entry no longer matched it, so the offer went away.
    /// </summary>
    [Fact]
    public void KeystrokesThatHaveNotBeenProcessedYetAreWaitedFor()
    {
        RewritePlan plan = MidFieldPlan();
        // Nothing, nothing, then all of it: the app got round to its queue.
        ScriptedField field = new(Before, Before, plan.SplicedFullText);

        SettledWrite settled = Resolve(plan, Before, reported: 8, field);

        Assert.IsType<SettledWrite.Complete>(settled);
        Assert.Equal(3, field.Reads);
    }

    /// <summary>
    /// The same, stopping half way: the app consumed part of the queue and
    /// stopped. A single read taken before it started would have called this an
    /// untouched field.
    /// </summary>
    [Fact]
    public void AWriteThatLandsHalfWayThroughTheWindowIsStillSeen()
    {
        RewritePlan plan = MidFieldPlan();
        string half = PartialWrite.OverSelection(plan, Before, 4)!.FieldText;
        ScriptedField field = new(Before, Before, half);

        SettledWrite settled = Resolve(plan, Before, reported: 4, field);

        SettledWrite.Half landed = Assert.IsType<SettledWrite.Half>(settled);
        Assert.Equal(half, landed.Partial.FieldText);
        Assert.Equal(Before, landed.Partial.Undone);
    }

    // ------------------------------------------ the count is a bound, not fact

    /// <summary>
    /// The second failure: the app consumed fewer characters than SendInput
    /// reported. The old code demanded the field equal the one state the count
    /// predicted, did not find it, and answered "landed somewhere this cannot
    /// account for" with nothing recorded, which is the exact state the whole
    /// recovery exists to abolish.
    /// </summary>
    [Fact]
    public void FewerCharactersThanReportedIsStillIdentifiedAndUndoable()
    {
        RewritePlan plan = MidFieldPlan();
        string two = PartialWrite.OverSelection(plan, Before, 2)!.FieldText;
        ScriptedField field = new(two, two, two);

        SettledWrite settled = Resolve(plan, Before, reported: 6, field);

        SettledWrite.Half landed = Assert.IsType<SettledWrite.Half>(settled);
        Assert.Equal("I use As daily", landed.Partial.FieldText);
        Assert.Equal(Before, landed.Partial.Undone);
        Assert.Equal(Before, landed.Partial.Entry(Key).FieldTextBefore);
    }

    /// <summary>
    /// And one more than reported, which is the honest reading of
    /// <c>Keyboard.Deliver</c>: a call cut between a key down and its key up
    /// delivered that character and counted the pair as not landed.
    /// </summary>
    [Fact]
    public void OneMoreCharacterThanReportedIsTheTerminalState()
    {
        RewritePlan plan = MidFieldPlan();
        string five = PartialWrite.OverSelection(plan, Before, 5)!.FieldText;
        ScriptedField field = new(five, Before, Before);

        SettledWrite settled = Resolve(plan, Before, reported: 4, field);

        SettledWrite.Half landed = Assert.IsType<SettledWrite.Half>(settled);
        Assert.Equal(five, landed.Partial.FieldText);
        // Nothing further can arrive, so the settle stops rather than spend the
        // rest of the window watching a field that is done changing.
        Assert.Equal(1, field.Reads);
        Assert.Equal(0, field.Waits);
    }

    /// <summary>
    /// A state that is neither predicted nor bounded by the count is still
    /// identified, because the field is the evidence and every hypothesis undoes
    /// to the same original text. Answering "unexplained" here would leave the
    /// user with a half-written field and no way back.
    /// </summary>
    [Fact]
    public void MoreCharactersThanReportedAreIdentifiedRatherThanRefused()
    {
        RewritePlan plan = MidFieldPlan();
        string seven = PartialWrite.OverSelection(plan, Before, 7)!.FieldText;
        ScriptedField field = new(seven, seven);

        SettledWrite settled = Resolve(plan, Before, reported: 2, field);

        SettledWrite.Half landed = Assert.IsType<SettledWrite.Half>(settled);
        Assert.Equal(seven, landed.Partial.FieldText);
        Assert.Equal(Before, landed.Partial.Undone);
    }

    /// <summary>The property that matters, over every state the app could stop at.</summary>
    [Fact]
    public void EverySettledStateUndoesBackToWhatTheUserHad()
    {
        RewritePlan plan = MidFieldPlan();

        for (int landed = 1; landed < plan.NewText.Length; landed++)
        {
            string text = PartialWrite.OverSelection(plan, Before, landed)!.FieldText;
            for (int reported = 0; reported <= plan.NewText.Length; reported++)
            {
                SettledWrite settled = Resolve(plan, Before, reported, new ScriptedField(text, text, text));
                SettledWrite.Half half = Assert.IsType<SettledWrite.Half>(settled);
                Assert.Equal(Before, half.Partial.Undone);
                Assert.Equal(Before, half.Partial.Entry(Key).FieldTextBefore);
            }
        }
    }

    // ------------------------------------------------- nothing landed at all

    /// <summary>
    /// SendInput refused the call outright, which is what UIPI does to an
    /// elevated window. Nothing was queued, so nothing can arrive later, and the
    /// engine is free to repair the field with the whole-value write. It must
    /// not spend the settle window finding that out.
    /// </summary>
    [Fact]
    public void NothingAcceptedIsDecidedOnTheFirstLook()
    {
        RewritePlan plan = MidFieldPlan();
        ScriptedField field = new(Before, Before, Before);

        SettledWrite settled = Resolve(plan, Before, reported: 0, field);

        SettledWrite.Untouched untouched = Assert.IsType<SettledWrite.Untouched>(settled);
        Assert.Null(untouched.Pending);
        Assert.Equal(1, field.Reads);
        Assert.Equal(0, field.Waits);
    }

    /// <summary>
    /// Keystrokes the system took and the field never showed. The caller must
    /// not write over them, so the settle waits out the whole window first and
    /// then hands back what the field will hold if they do turn up, which is
    /// what makes a late arrival reversible.
    /// </summary>
    [Fact]
    public void AcceptedKeystrokesThatNeverAppearAreWaitedOutAndDescribed()
    {
        RewritePlan plan = MidFieldPlan();
        ScriptedField field = new(Before, Before, Before, Before);

        SettledWrite settled = Resolve(plan, Before, reported: 4, field);

        SettledWrite.Untouched untouched = Assert.IsType<SettledWrite.Untouched>(settled);
        Assert.Equal(4, field.Reads);
        Assert.Equal(3, field.Waits);
        Assert.NotNull(untouched.Pending);
        Assert.Equal("I use Ashl daily", untouched.Pending!.FieldText);
        Assert.Equal(Before, untouched.Pending.Undone);
    }

    /// <summary>
    /// The same when the system took all of them: the state that would arrive is
    /// the whole correction, and it needs the same ledger entry a write that
    /// worked first time gets.
    /// </summary>
    [Fact]
    public void EverythingAcceptedAndNothingShownIsDescribedAsTheWholeCorrection()
    {
        RewritePlan plan = MidFieldPlan();
        ScriptedField field = new(Before, Before);

        SettledWrite settled = Resolve(plan, Before, reported: plan.NewText.Length, field);

        SettledWrite.Untouched untouched = Assert.IsType<SettledWrite.Untouched>(settled);
        Assert.Equal(plan.SplicedFullText, untouched.Pending!.FieldText);
        Assert.Equal(Before, untouched.Pending.Undone);
    }

    /// <summary>
    /// A replacement that starts with the text it replaces leaves the field
    /// holding exactly what it held before, for a while. That reading is the
    /// truthful one: the user's text is all still there, and calling it a
    /// partial write would record an undo that deletes characters the user
    /// typed.
    /// </summary>
    [Fact]
    public void AReplacementWhosePrefixIsTheOriginalReadsAsUntouched()
    {
        RewritePlan plan = Plan("I use ashler daily", new TextSpan(6, 6), "ashlerly");
        ScriptedField field = new("I use ashler daily", "I use ashler daily");

        SettledWrite settled = KeystrokeSettle.Resolve(
            "I use ashler daily", plan.SplicedFullText, plan.NewText.Length, 6,
            OverSelection(plan, "I use ashler daily"), field);

        SettledWrite.Untouched untouched = Assert.IsType<SettledWrite.Untouched>(settled);
        // Those six characters arriving would not change a character of the
        // field, so there is nothing to offer to take back out.
        Assert.Null(untouched.Pending);
    }

    /// <summary>
    /// Text that no hypothesis explains: the user typed, or another app wrote,
    /// while this was happening. The engine stops rather than write on top of a
    /// field it no longer understands.
    /// </summary>
    [Fact]
    public void AFieldHoldingSomethingElseEntirelyIsUnexplained()
    {
        RewritePlan plan = MidFieldPlan();
        ScriptedField field = new("something else altogether", "something else altogether");

        SettledWrite settled = Resolve(plan, Before, reported: 4, field);

        SettledWrite.Unexplained unexplained = Assert.IsType<SettledWrite.Unexplained>(settled);
        Assert.Equal("something else altogether", unexplained.FieldText);
    }

    /// <summary>A field that cannot be read is not a field that was written to.</summary>
    [Fact]
    public void AFieldThatCannotBeReadIsUnexplainedRatherThanAssumed()
    {
        RewritePlan plan = MidFieldPlan();
        SettledWrite settled = KeystrokeSettle.Resolve(
            Before, plan.SplicedFullText, plan.NewText.Length, 4,
            OverSelection(plan, Before), new NullField());

        Assert.IsType<SettledWrite.Unexplained>(settled);
    }

    private sealed class NullField : ISettlePoll
    {
        public string? Read() => null;

        public bool KeepWaiting() => false;
    }

    // --------------------------------------------------- backspace and retype

    /// <summary>
    /// The tail path with the same race, and worse stakes: the backspaces go
    /// first, so every event that lands destroys a character before any of them
    /// puts one back.
    /// </summary>
    [Fact]
    public void BackspacesThatLandLateAreSeenRatherThanMissed()
    {
        RewritePlan plan = TailPlan();
        const string before = "I use ashler";
        int events = plan.PreviousText.Length + plan.NewText.Length;
        string deleted = PartialWrite.OverTail(plan, before, 6)!.FieldText;
        ScriptedField field = new(before, deleted, deleted);

        SettledWrite settled = KeystrokeSettle.Resolve(
            before, plan.SplicedFullText, events, 6, OverTail(plan, before, events), field);

        SettledWrite.Half half = Assert.IsType<SettledWrite.Half>(settled);
        Assert.Equal("I use ", half.Partial.FieldText);
        Assert.Equal(before, half.Partial.Undone);
    }

    [Fact]
    public void EveryTailStateUndoesBackToWhatTheUserHad()
    {
        RewritePlan plan = TailPlan();
        const string before = "I use ashler";
        int events = plan.PreviousText.Length + plan.NewText.Length;

        for (int landed = 1; landed < events; landed++)
        {
            string text = PartialWrite.OverTail(plan, before, landed)!.FieldText;
            SettledWrite settled = KeystrokeSettle.Resolve(
                before, plan.SplicedFullText, events, landed, OverTail(plan, before, events),
                new ScriptedField(text, text));

            SettledWrite.Half half = Assert.IsType<SettledWrite.Half>(settled);
            Assert.Equal(before, half.Partial.Undone);
            Assert.Equal(before, half.Partial.Entry(Key).FieldTextBefore);
        }
    }

    /// <summary>
    /// The tail write arriving in full after the caller gave up on it. Without a
    /// description of that state the correction would sit in the field with no
    /// ledger entry behind it.
    /// </summary>
    [Fact]
    public void ATailWriteThatArrivesLateIsComplete()
    {
        RewritePlan plan = TailPlan();
        const string before = "I use ashler";
        int events = plan.PreviousText.Length + plan.NewText.Length;
        ScriptedField field = new(before, plan.SplicedFullText);

        SettledWrite settled = KeystrokeSettle.Resolve(
            before, plan.SplicedFullText, events, events, OverTail(plan, before, events), field);

        Assert.IsType<SettledWrite.Complete>(settled);
    }
}
