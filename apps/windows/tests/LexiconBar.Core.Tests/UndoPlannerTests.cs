using Xunit;

namespace LexiconBar.Tests;

/// <summary>
/// Everything the undo hotkey decides before it touches the field.
///
/// Undo is a read followed by a write, so it is a read like any other and has
/// to ask the gate first. It used to go straight to the value, which made
/// Ctrl+Alt+Z the one path where excluding an app while it still held focus
/// stopped neither the read nor the write, while every other path in the engine
/// refused it. macOS had the same hole in the same method.
///
/// The ordering lived three lines deep in a method that also drives UI
/// Automation and synthesizes keystrokes, in a project no headless runner can
/// load, so nothing would have gone red if the two were swapped back. It lives
/// in <see cref="UndoPlanner"/> now, and the field below counts its reads.
/// </summary>
public class UndoPlannerTests
{
    private const int Limit = 20_001;

    private const string Corrected = "Ashlr.AI is great";
    private const string Original = "ashler ai is great";

    /// <summary>The ledger as it stands just after a correction landed in <paramref name="key"/>.</summary>
    private static UndoLedger LedgerFor(string key = "field-1")
    {
        UndoLedger ledger = new();
        ledger.Record(new UndoLedger.Entry(
            key,
            new TextSpan(0, "ashler ai".Length),
            CorrectedText: "Ashlr.AI",
            PreviousText: "ashler ai",
            FieldTextAfter: Corrected));
        return ledger;
    }

    private static RecordingField Vault() =>
        new("1Password", new FieldHints(Title: "Notes"), Corrected);

    private static RecordingField Ordinary(string value = Corrected) =>
        new("obscurevault", new FieldHints(Title: "Item"), value);

    // ------------------------------------------------- refused, and not read

    /// <summary>
    /// The headline. Put the read back in front of the gate, which is what the
    /// old code did, and the vault field is read before anything refuses it:
    /// the count goes to one and this fails. Note that the ledger holds an
    /// entry that would otherwise apply, so there is a real undo here to be
    /// refused.
    /// </summary>
    [Fact]
    public void AFieldTheGateRefusesIsNotReadByUndoEither()
    {
        ReadPolicy policy = new();
        RecordingField field = Vault();

        UndoDecision decision = UndoPlanner.Plan(policy, field, LedgerFor(), watching: true, Limit);

        Assert.Equal(0, field.Reads);
        UndoDecision.Refused refused = Assert.IsType<UndoDecision.Refused>(decision);
        Assert.Contains("1password", refused.Reason);
    }

    /// <summary>
    /// The entry describes that field and carries a span of its text, so a
    /// refusal has to take it with it rather than leave it for whatever gets
    /// focus next.
    /// </summary>
    [Fact]
    public void ARefusedUndoDropsTheEntryThatHeldThatFieldsText()
    {
        UndoLedger ledger = LedgerFor();

        UndoDecision decision = UndoPlanner.Plan(new ReadPolicy(), Vault(), ledger, watching: true, Limit);

        Assert.IsType<UndoDecision.Refused>(decision);
        Assert.Null(ledger.Last);
    }

    /// <summary>
    /// The secret-field heuristic is the guard for apps nobody has put on any
    /// list, and undo has to be behind it too. Notepad is not excluded and
    /// never will be.
    /// </summary>
    [Fact]
    public void ASecretLookingFieldIsNotReadByUndoEither()
    {
        RecordingField field = new("notepad", new FieldHints(Identifier: "totpSeedField"), Corrected);

        UndoDecision decision = UndoPlanner.Plan(new ReadPolicy(), field, LedgerFor(), watching: true, Limit);

        Assert.Equal(0, field.Reads);
        Assert.IsType<UndoDecision.Refused>(decision);
    }

    /// <summary>
    /// With "Fix everywhere" off, the hotkey is still bound and the user can
    /// still press it. Revert the switch check and it reads the field.
    /// </summary>
    [Fact]
    public void WhileFixEverywhereIsOffUndoReadsNothing()
    {
        ReadPolicy policy = new();
        RecordingField field = Ordinary();
        UndoLedger ledger = LedgerFor();
        policy.SetEnabled(false);

        UndoDecision decision = UndoPlanner.Plan(policy, field, ledger, watching: true, Limit);

        Assert.Equal(0, field.Reads);
        Assert.IsType<UndoDecision.Off>(decision);

        // Nothing was refused about the field itself, so the offer survives
        // being switched off and on again.
        Assert.NotNull(ledger.Last);
    }

    /// <summary>
    /// The scenario the fix was written for, end to end: a correction lands, the
    /// user excludes that app from the tray menu without leaving the field, and
    /// then presses Ctrl+Alt+Z. The read count is the assertion. It was one
    /// before the exclusion and has to still be one after it, and the write the
    /// engine would have done next never gets a plan.
    /// </summary>
    [Fact]
    public void ExcludingTheAppMidFocusStopsTheUndoBeforeItReads()
    {
        ReadPolicy policy = new();
        RecordingField field = Ordinary();
        UndoLedger ledger = LedgerFor();
        policy.SetExclusions(new AppExclusions(new[] { "windowsterminal" }));

        Assert.IsType<UndoDecision.Go>(UndoPlanner.Plan(policy, field, ledger, watching: true, Limit));
        Assert.Equal(1, field.Reads);

        policy.SetExclusions(new AppExclusions(new[] { "windowsterminal", "obscurevault" }));

        Assert.IsType<UndoDecision.Refused>(UndoPlanner.Plan(policy, field, ledger, watching: true, Limit));
        Assert.Equal(1, field.Reads);
    }

    /// <summary>
    /// The gate comes before every other reason to decline, not just before the
    /// write. Move it behind the "is anything watching this field" check and a
    /// vault field in an unwatched app answers <c>NotWatching</c>, which reads
    /// as harmless and is how a refusal stops being one.
    /// </summary>
    [Fact]
    public void TheGateIsAskedBeforeTheDetectorAndBeforeTheLedger()
    {
        RecordingField field = Vault();

        UndoDecision decision = UndoPlanner.Plan(new ReadPolicy(), field, new UndoLedger(), watching: false, Limit);

        Assert.Equal(0, field.Reads);
        Assert.IsType<UndoDecision.Refused>(decision);
    }

    // ------------------------------------------------------------- admitted

    /// <summary>
    /// An ordinary field, read once, with the two texts the other way round:
    /// the correction is what is in the field now, and the user's own words are
    /// what goes back in.
    /// </summary>
    [Fact]
    public void AnAdmittedUndoIsReadOnceAndPutsTheOriginalBack()
    {
        RecordingField field = Ordinary();

        UndoDecision decision = UndoPlanner.Plan(new ReadPolicy(), field, LedgerFor(), watching: true, Limit);

        Assert.Equal(1, field.Reads);
        UndoDecision.Go go = Assert.IsType<UndoDecision.Go>(decision);
        Assert.Equal(Corrected, go.CurrentText);
        Assert.Equal(new TextSpan(0, "Ashlr.AI".Length), go.Plan.Span);
        Assert.Equal("Ashlr.AI", go.Plan.PreviousText);
        Assert.Equal("ashler ai", go.Plan.NewText);
        Assert.Equal(Original, go.Plan.SplicedFullText);
    }

    /// <summary>
    /// The user typed on after the correction, so every offset in the ledger is
    /// stale and the offer is withdrawn rather than fired at the wrong place.
    /// </summary>
    [Fact]
    public void NothingToUndoOnceTheUserHasTypedOnSince()
    {
        RecordingField field = Ordinary("Ashlr.AI is great, and then some");
        UndoLedger ledger = LedgerFor();

        UndoDecision decision = UndoPlanner.Plan(new ReadPolicy(), field, ledger, watching: true, Limit);

        Assert.Equal(1, field.Reads);
        UndoDecision.Nothing nothing = Assert.IsType<UndoDecision.Nothing>(decision);
        Assert.Equal("Ashlr.AI is great, and then some", nothing.CurrentText);

        // Withdrawn, not consumed: the entry is still the record of what was
        // corrected, and the tray reads it back for "Last correction".
        Assert.NotNull(ledger.Last);
    }

    [Fact]
    public void NothingToUndoWhenNoCorrectionWasEverRecorded()
    {
        RecordingField field = Ordinary();

        UndoDecision decision = UndoPlanner.Plan(new ReadPolicy(), field, new UndoLedger(), watching: true, Limit);

        Assert.IsType<UndoDecision.Nothing>(decision);
    }

    /// <summary>
    /// A correction recorded in one field does not apply to another, even when
    /// the two happen to hold the same text.
    /// </summary>
    [Fact]
    public void AnEntryFromAnotherFieldDoesNotApply()
    {
        RecordingField field = new("obscurevault", new FieldHints(Title: "Item"), Corrected, key: "field-2");

        UndoDecision decision = UndoPlanner.Plan(new ReadPolicy(), field, LedgerFor("field-1"), watching: true, Limit);

        Assert.IsType<UndoDecision.Nothing>(decision);
    }

    /// <summary>
    /// Admitted, read, and then nothing to do: no detector is following this
    /// field, so there is no correction of ours in it.
    /// </summary>
    [Fact]
    public void AFieldNobodyIsWatchingHasNothingOfOursInIt()
    {
        RecordingField field = Ordinary();

        UndoDecision decision = UndoPlanner.Plan(new ReadPolicy(), field, LedgerFor(), watching: false, Limit);

        Assert.IsType<UndoDecision.NotWatching>(decision);
    }
}
