namespace LexiconBar.Tests;

/// <summary>
/// A field that answers metadata freely and records every attempt to fetch its
/// value. The stand-in for a UI Automation provider: <c>UiaField</c> implements
/// the same interface, and its <c>ReadValue</c> is the cross-process call that
/// would pull the user's text, or their TOTP seed, into this process.
///
/// <see cref="Reads"/> is what the suites around it are for. A refusal that
/// happens after the read still corrects nothing and still logs nothing, and is
/// still the bug: the secret is in memory, where a crash dump can reach it. So
/// every refusal case asserts this count is zero, and a regression that puts
/// the decision back behind the read fails on the count rather than on the
/// outcome.
/// </summary>
internal sealed class RecordingField : IInspectableField
{
    private readonly string _value;

    internal RecordingField(
        string processName,
        FieldHints hints,
        string value = "whatever was typed",
        string key = "field-1")
    {
        ProcessName = processName;
        Hints = hints;
        _value = value;
        Key = key;
    }

    public string Key { get; }

    public string ProcessName { get; }

    public FieldHints Hints { get; }

    /// <summary>How many times anything asked for this field's text.</summary>
    internal int Reads { get; private set; }

    public string? ReadValue(int limit)
    {
        Reads += 1;
        return _value.Length <= limit ? _value : _value[..limit];
    }
}
