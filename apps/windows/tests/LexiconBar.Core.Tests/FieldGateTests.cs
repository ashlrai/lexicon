using Xunit;

namespace LexiconBar.Tests;

/// <summary>
/// The gate that decides whether a focused field's text may be read at all.
///
/// The property these tests exist for is not "a refused field is not corrected"
/// — that was always true — but "a refused field is <b>never read</b>". A
/// refusal that happens after the read leaves the user's TOTP seed or vault
/// note sitting in this process's memory, where a crash dump or a debugger can
/// reach it, which is precisely what the threat model in SECURITY.md says does
/// not happen.
///
/// So <see cref="RecordingField"/> counts the reads, and every refusal case
/// asserts that count is zero. A regression that moves the decision back behind
/// the read still corrects nothing and still logs nothing — and fails here.
/// </summary>
public class FieldGateTests
{
    /// <summary>
    /// A field that answers metadata freely and records every attempt to fetch
    /// its value. The stand-in for a UIA provider: <c>UiaField</c> implements
    /// the same interface, and its <c>ReadValue</c> is the cross-process call
    /// that would pull the secret over.
    /// </summary>
    private sealed class RecordingField : IInspectableField
    {
        private readonly string _value;

        internal RecordingField(string processName, FieldHints hints, string value = "whatever was typed")
        {
            ProcessName = processName;
            Hints = hints;
            _value = value;
        }

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

    private static readonly AppExclusions Defaults = new();

    // ------------------------------------------------- refused, and not read

    [Fact]
    public void AnExcludedAppsFieldIsNeverRead()
    {
        RecordingField field = new("1Password", new FieldHints(Title: "Notes"));

        FieldRead read = FieldGate.Read(field, Defaults, 20_001);

        Assert.Equal(0, field.Reads);
        Assert.True(read.Refused);
        Assert.Null(read.Value);
        Assert.Contains("1password", read.Refusal);
    }

    /// <summary>
    /// The case the whole heuristic exists for: an app nobody has put on any
    /// list, holding a field whose label gives it away. Notepad is not
    /// excluded and never will be.
    /// </summary>
    [Fact]
    public void ASecretLookingFieldInAnOrdinaryAppIsNeverRead()
    {
        RecordingField field = new("notepad", new FieldHints(Identifier: "totpSeedField"));

        FieldRead read = FieldGate.Read(field, Defaults, 20_001);

        Assert.Equal(0, field.Reads);
        Assert.True(read.Refused);
        Assert.Contains("seed", read.Refusal);
    }

    /// <summary>
    /// Classic Credential Manager runs inside rundll32, which cannot be
    /// excluded by name without excluding every control panel applet. The
    /// window title is the only thing that gives it away — and it is metadata,
    /// so the gate can see it without reading anything.
    /// </summary>
    [Fact]
    public void AWindowTitleAloneIsEnoughToRefuse()
    {
        RecordingField field = new("rundll32", new FieldHints(Title: "User name", WindowTitle: "Stored User Names and Passwords"));

        FieldRead read = FieldGate.Read(field, Defaults, 20_001);

        Assert.Equal(0, field.Reads);
        Assert.True(read.Refused);
    }

    /// <summary>
    /// Excluding the app the user is in right now has to stop the reads, not
    /// just the corrections: the watcher re-asks the gate on every poll, so a
    /// list that changed mid-focus refuses from that moment on.
    /// </summary>
    [Fact]
    public void ExcludingAnAppStopsItBeingReadFromThenOn()
    {
        RecordingField field = new("obscurevault", new FieldHints(Title: "Item"));
        AppExclusions exclusions = new(new[] { "windowsterminal" });

        Assert.False(FieldGate.Read(field, exclusions, 20_001).Refused);
        Assert.Equal(1, field.Reads);

        exclusions.Exclude("obscurevault");

        Assert.True(FieldGate.Read(field, exclusions, 20_001).Refused);
        Assert.Equal(1, field.Reads);
    }

    [Theory]
    [InlineData("keepassxc", "Notes")]
    [InlineData("bitwarden", "Custom field")]
    [InlineData("chrome", "Master Password")]
    [InlineData("code", "Recovery code")]
    [InlineData("windowsterminal", "Search")]
    public void NothingRefusedIsEverRead(string process, string label)
    {
        RecordingField field = new(process, new FieldHints(Title: label));

        Assert.True(FieldGate.Read(field, Defaults, 20_001).Refused);
        Assert.Equal(0, field.Reads);
    }

    // ------------------------------------------------------------- admitted

    [Fact]
    public void AnOrdinaryFieldIsReadExactlyOnce()
    {
        RecordingField field = new("chrome", new FieldHints(Title: "Message body"), "the quick brown fox");

        FieldRead read = FieldGate.Read(field, Defaults, 20_001);

        Assert.Equal(1, field.Reads);
        Assert.False(read.Refused);
        Assert.Null(read.Refusal);
        Assert.Equal("the quick brown fox", read.Value);
    }

    /// <summary>The read limit is the caller's, and the gate does not get in its way.</summary>
    [Fact]
    public void TheReadLimitIsPassedThrough()
    {
        RecordingField field = new("notepad", new FieldHints(Title: "Document"), "abcdefghij");

        Assert.Equal("abcde", FieldGate.Read(field, Defaults, 5).Value);
    }

    /// <summary>
    /// A field that cannot be read is not a field that was refused. The watcher
    /// treats the two differently — one means "the element is gone, re-resolve
    /// focus", the other means "do not touch this".
    /// </summary>
    [Fact]
    public void AnUnreadableFieldIsNotARefusal()
    {
        FieldRead read = FieldGate.Read(new UnreadableField(), Defaults, 20_001);

        Assert.False(read.Refused);
        Assert.Null(read.Value);
    }

    private sealed class UnreadableField : IInspectableField
    {
        public string ProcessName => "notepad";

        public FieldHints Hints => new(Title: "Document");

        public string? ReadValue(int limit) => null;
    }

    // ----------------------------------------------------- the refusal alone

    [Fact]
    public void RefuseNamesTheTermThatMatched() =>
        Assert.Contains("api key", FieldGate.Refuse(Defaults, "notepad", new FieldHints(Placeholder: "Paste your API key"))!);

    [Fact]
    public void RefuseAdmitsOrdinaryWriting() =>
        Assert.Null(FieldGate.Refuse(Defaults, "winword", new FieldHints(Title: "Document", WindowTitle: "Shipping notes.docx")));
}
