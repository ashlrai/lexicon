using Xunit;

namespace LexiconBar.Tests;

/// <summary>
/// The master switch, and what has to happen to the watcher's state when it
/// moves.
///
/// <c>FieldGateTests</c> covers the per-field half of the decision: is this
/// particular field one whose contents are off limits. These cover the half
/// that is not about the field at all. "Turn Fix everywhere off" is what
/// SECURITY.md offers a user who does not want their typing read, so it has to
/// mean that nothing is read. It once meant only that nothing was corrected:
/// the engine stopped acting while the watcher carried on resolving focus,
/// reading every focused field and caching its text. Nothing was sent
/// anywhere, and a crash dump would still have carried it.
///
/// That switch used to be a bool inside <c>FocusWatcher</c>, which targets
/// net8.0-windows and cannot load on the runner that gates this repo, so it
/// was verified by reading it. Here it is verified by a field that counts
/// reads.
/// </summary>
public class ReadPolicyTests
{
    private const int Limit = 20_001;

    private static RecordingField Ordinary(string value = "the quick brown fox") =>
        new("obscurevault", new FieldHints(Title: "Item"), value);

    // ------------------------------------------------- the switch, and reads

    /// <summary>
    /// The one that matters. Revert the fix, by having the policy consult only
    /// the exclusion list and not the switch, and this field is read while the
    /// user believes nothing is being read: the count goes to one and this
    /// fails. It fails the same way if the switch is checked after the value
    /// has been fetched rather than before.
    /// </summary>
    [Fact]
    public void WhileFixEverywhereIsOffAFieldIsNeverRead()
    {
        ReadPolicy policy = new();
        RecordingField field = Ordinary();

        policy.SetEnabled(false);
        FieldRead read = policy.Read(field, Limit);

        Assert.Equal(0, field.Reads);
        Assert.True(read.Refused);
        Assert.Null(read.Value);
        Assert.Contains("off", read.Refusal);
        Assert.False(policy.Enabled);
    }

    /// <summary>
    /// The other side of it, so the test above cannot pass by refusing
    /// everything. Nothing about this field changed between the two.
    /// </summary>
    [Fact]
    public void TurningItBackOnReadsTheSameFieldAgain()
    {
        ReadPolicy policy = new();
        RecordingField field = Ordinary();

        policy.SetEnabled(false);
        Assert.True(policy.Read(field, Limit).Refused);
        Assert.Equal(0, field.Reads);

        policy.SetEnabled(true);
        FieldRead read = policy.Read(field, Limit);

        Assert.Equal(1, field.Reads);
        Assert.False(read.Refused);
        Assert.Equal("the quick brown fox", read.Value);
    }

    /// <summary>
    /// The caret measurement in <c>FixEngine.Settle</c> pulls text across
    /// without going through <see cref="ReadPolicy.Read"/>, so it asks
    /// <see cref="ReadPolicy.Refuse"/> instead. That answer has to honour the
    /// switch too, and cost nothing but metadata to get.
    /// </summary>
    [Fact]
    public void RefuseHonoursTheSwitchAndCostsNoRead()
    {
        ReadPolicy policy = new();
        RecordingField field = Ordinary();

        Assert.Null(policy.Refuse(field.ProcessName, field.Hints));

        policy.SetEnabled(false);

        Assert.NotNull(policy.Refuse(field.ProcessName, field.Hints));
        Assert.Equal(0, field.Reads);
    }

    /// <summary>
    /// Refusing the next read is not enough on its own: the watcher is holding
    /// the last field and its text, and the poll is still armed. Revert the
    /// fix to a bare flag flip, leaving the cached value and the poll in place,
    /// and this fails.
    /// </summary>
    [Fact]
    public void TurningItOffAsksForWhatIsHeldToBeDropped()
    {
        ReadPolicy policy = new();

        ReadPolicyChange change = policy.SetEnabled(false);

        Assert.True(change.StopReading);
        Assert.False(change.ResumeReading);
        Assert.False(change.RecheckCurrentField);
    }

    /// <summary>
    /// And back: with the switch off the watcher resolved no focus at all, so
    /// turning it on has to go and look rather than wait for the next focus
    /// change, which in an app that already has focus never comes.
    /// </summary>
    [Fact]
    public void TurningItOnAsksForFocusToBeResolvedAgain()
    {
        ReadPolicy policy = new();
        policy.SetEnabled(false);

        ReadPolicyChange change = policy.SetEnabled(true);

        Assert.True(change.ResumeReading);
        Assert.False(change.StopReading);
        Assert.True(policy.Enabled);
    }

    /// <summary>
    /// Settings are pushed whole on every change, so the switch is told what it
    /// already knows several times a session. Dropping the focused field each
    /// time would throw away the detector's history mid-sentence.
    /// </summary>
    [Fact]
    public void PushingTheAnswerItAlreadyHasChangesNothing()
    {
        ReadPolicy policy = new();

        Assert.Equal(ReadPolicyChange.Nothing, policy.SetEnabled(true));

        policy.SetEnabled(false);

        Assert.Equal(ReadPolicyChange.Nothing, policy.SetEnabled(false));
    }

    // ------------------------------------------------------ the list, and reads

    /// <summary>
    /// Excluding the app that has focus right now, from the tray menu, while
    /// its text is already in the watcher's hands. The new list has to reach
    /// the reads and not only the corrections.
    /// </summary>
    [Fact]
    public void ANewListRechecksTheFieldInFrontAndThenRefusesIt()
    {
        ReadPolicy policy = new();
        RecordingField field = Ordinary();

        policy.SetExclusions(new AppExclusions(new[] { "windowsterminal" }));
        Assert.False(policy.Read(field, Limit).Refused);
        Assert.Equal(1, field.Reads);

        ReadPolicyChange change = policy.SetExclusions(
            new AppExclusions(new[] { "windowsterminal", "obscurevault" }));

        Assert.True(change.RecheckCurrentField);
        Assert.True(policy.Read(field, Limit).Refused);
        Assert.Equal(1, field.Reads);
    }

    /// <summary>
    /// The watcher is constructed before any setting reaches it. "No exclusions
    /// yet" must never be the state something gets read in, so the list starts
    /// at the defaults rather than empty.
    /// </summary>
    [Fact]
    public void BeforeAnySettingArrivesTheDefaultListIsAlreadyInForce()
    {
        ReadPolicy policy = new();
        RecordingField vault = new("1Password", new FieldHints(Title: "Notes"));

        Assert.True(policy.Read(vault, Limit).Refused);
        Assert.Equal(0, vault.Reads);
    }
}
