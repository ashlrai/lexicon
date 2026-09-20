namespace LexiconBar;

/// <summary>
/// A focused field as seen from the platform-independent side: its identity and
/// its labels, both of which are metadata, plus the one call that actually
/// pulls the user's text across the process boundary.
///
/// The split is the whole point. <see cref="ProcessName"/> and
/// <see cref="Hints"/> can be inspected for free — they are what the window
/// manager and the accessibility tree say *about* the field. <see cref="ReadValue"/>
/// is the first moment the user's own text enters this process, so
/// <see cref="FieldGate"/> gets to decide before it is ever called.
/// </summary>
public interface IInspectableField
{
    /// <summary>The owning executable's name, as <see cref="AppExclusions"/> matches it.</summary>
    string ProcessName { get; }

    /// <summary>The field's and its window's labels. Metadata, never the value.</summary>
    FieldHints Hints { get; }

    /// <summary>The field's text. Only ever called for a field the gate admitted.</summary>
    string? ReadValue(int limit);
}

/// <summary>The outcome of asking the gate for a field's text.</summary>
/// <param name="Value">The text, or null when the field was refused or could not be read.</param>
/// <param name="Refusal">Why the field was refused, or null when it was admitted.</param>
public readonly record struct FieldRead(string? Value, string? Refusal)
{
    public bool Refused => Refusal is not null;
}

/// <summary>
/// The one place that decides whether a field's contents may be read at all.
///
/// This used to live a layer up, in the app's burst detector: the watcher read
/// every focused field and cached it, and the exclusion list and
/// <see cref="SecretFieldHeuristic"/> only decided, afterwards, whether to act
/// on what had already been read. That made the refusal a policy about what we
/// *do* with a secret rather than about whether we hold one, and a vault notes
/// field or a TOTP box in an app that is not on the exclusion list sat in the
/// watcher's cache, refreshed on every poll, for as long as it had focus.
/// Nothing was sent or logged, but a crash dump would have carried it.
///
/// So the decision moved in front of the read. A refused field is never asked
/// for its value: <see cref="Read"/> returns without calling
/// <see cref="IInspectableField.ReadValue"/> at all, which is what
/// <c>FieldGateTests</c> asserts. The checks downstream stay where they are as
/// defence in depth.
/// </summary>
public static class FieldGate
{
    /// <summary>
    /// Why this field's contents must never be read, or null when they may be.
    ///
    /// Pure string work over metadata the caller already has, so it is cheap
    /// enough to re-run on every poll — which matters, because the user can add
    /// an app to the exclusion list while that app still holds focus.
    /// </summary>
    public static string? Refuse(AppExclusions exclusions, string? processName, FieldHints hints)
    {
        ArgumentNullException.ThrowIfNull(exclusions);
        ArgumentNullException.ThrowIfNull(hints);

        if (exclusions.IsExcluded(processName))
        {
            return $"{AppExclusions.Normalize(processName)} is on the exclusion list";
        }

        if (SecretFieldHeuristic.Match(hints) is string term)
        {
            return $"the field's labels look like a secret ({term})";
        }

        return null;
    }

    /// <summary>
    /// The field's text, or a refusal. <paramref name="field"/> is asked for its
    /// value only when it is admitted.
    /// </summary>
    public static FieldRead Read(IInspectableField field, AppExclusions exclusions, int limit)
    {
        ArgumentNullException.ThrowIfNull(field);

        if (Refuse(exclusions, field.ProcessName, field.Hints) is string refusal)
        {
            return new FieldRead(null, refusal);
        }

        return new FieldRead(field.ReadValue(limit), null);
    }
}
