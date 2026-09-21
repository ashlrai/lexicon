namespace LexiconBar;

/// <summary>
/// What a change of policy asks the watcher to do next, so that the decision
/// and the acting on it are two separable things.
///
/// The watcher half is unrunnable here: it resolves focus and subscribes to UI
/// Automation events, neither of which exists on a headless runner. The
/// deciding half is pure, and this record is the seam between them. A test can
/// assert that turning "Fix everywhere" off asks for the cached field to be
/// dropped and the poll to stop, without a desktop session to drop it in.
/// </summary>
/// <param name="StopReading">
/// Stop polling, let go of whatever field is held and of its text, and forget
/// the last refusal so the next one is logged again.
/// </param>
/// <param name="ResumeReading">Resolve focus again and restart the poll.</param>
/// <param name="RecheckCurrentField">
/// Re-run the gate against the field being watched right now. The list can
/// change while the app it newly covers still holds focus.
/// </param>
public readonly record struct ReadPolicyChange(
    bool StopReading,
    bool ResumeReading,
    bool RecheckCurrentField)
{
    /// <summary>The push said nothing new, so there is nothing to do.</summary>
    public static ReadPolicyChange Nothing => default;
}

/// <summary>
/// Whether the app may read a focused field's text at all, and what has to
/// happen when that answer changes.
///
/// <see cref="FieldGate"/> answers the per-field half of the question: is this
/// particular field one whose contents are off limits. This adds the half that
/// is not about the field at all, the master switch, and it is the more
/// important of the two. "Turn Fix everywhere off" is the mitigation
/// <c>SECURITY.md</c> offers a user who does not want their typing read, so it
/// has to mean that nothing is read, rather than that everything is read and
/// nothing is corrected. It once meant the second thing: the engine stopped
/// correcting while the watcher carried on resolving focus, reading every
/// focused field and caching its text. macOS had the same gap.
///
/// The switch lives here, in the portable core, rather than as a bool inside
/// the watcher, because a bool inside the watcher can only be verified by
/// reading it. Here it is verified by <c>ReadPolicyTests</c>, which drives a
/// field that counts reads and asserts the count stays at zero.
///
/// Not thread safe. Each instance belongs to the thread that owns the state it
/// gates: the watcher's to the UI Automation thread, the engine's to the same
/// one.
/// </summary>
public sealed class ReadPolicy
{
    /// <summary>The refusal a caller gets while the master switch is off.</summary>
    public const string SwitchedOff = "Fix everywhere is off";

    /// <summary>
    /// True before anything has been pushed. The watcher is constructed before
    /// the settings reach it, and the engine pushes the real answer before the
    /// watcher subscribes to anything, so this value never gates a read in the
    /// running app. It is the permissive one only because the exclusion list
    /// below starts at its defaults rather than empty, which is where the
    /// conservative default that matters lives.
    /// </summary>
    private bool _enabled = true;

    private AppExclusions _exclusions = new();

    /// <summary>
    /// Whether a field's text may be read at all. False means no focus
    /// resolution, no poll, no read on an event, and nothing kept from before.
    /// </summary>
    public bool Enabled => _enabled;

    /// <summary>The list <see cref="FieldGate"/> matches on.</summary>
    public AppExclusions Exclusions => _exclusions;

    /// <summary>
    /// Flips the master switch and says what the caller must now do. Turning it
    /// off is not only a refusal of the next read: whatever is already held has
    /// to go with it, which is what <see cref="ReadPolicyChange.StopReading"/>
    /// asks for.
    /// </summary>
    public ReadPolicyChange SetEnabled(bool on)
    {
        if (on == _enabled) return ReadPolicyChange.Nothing;
        _enabled = on;
        return on
            ? new ReadPolicyChange(StopReading: false, ResumeReading: true, RecheckCurrentField: false)
            : new ReadPolicyChange(StopReading: true, ResumeReading: false, RecheckCurrentField: false);
    }

    /// <summary>
    /// Takes a new exclusion list. Always asks for the current field to be
    /// re-checked, including when the list compares equal: the caller pushes a
    /// fresh copy on every settings change, and a list that looks unchanged
    /// from here is not evidence that the field under it still passes.
    /// </summary>
    public ReadPolicyChange SetExclusions(AppExclusions exclusions)
    {
        ArgumentNullException.ThrowIfNull(exclusions);
        _exclusions = exclusions;
        return new ReadPolicyChange(StopReading: false, ResumeReading: false, RecheckCurrentField: true);
    }

    /// <summary>
    /// Why this field's contents must not be read, or null when they may be.
    /// Metadata only, so it costs no read and can be placed in front of any of
    /// them, including the ones that measure the field rather than fetch it.
    /// </summary>
    public string? Refuse(string? processName, FieldHints hints) =>
        _enabled ? FieldGate.Refuse(_exclusions, processName, hints) : SwitchedOff;

    /// <summary>
    /// The field's text, or a refusal. <paramref name="field"/> is asked for its
    /// value only when the switch is on and the gate admits it.
    /// </summary>
    public FieldRead Read(IInspectableField field, int limit)
    {
        ArgumentNullException.ThrowIfNull(field);
        return _enabled ? FieldGate.Read(field, _exclusions, limit) : new FieldRead(null, SwitchedOff);
    }
}
