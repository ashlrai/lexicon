using Windows.Win32;
using Windows.Win32.UI.Input.KeyboardAndMouse;

namespace LexiconBar.Interop;

/// <summary>
/// Synthesized keystrokes, which on Windows is the *primary* way a correction
/// gets written, not the last resort it is on macOS: UIA's TextPattern has no
/// setter, so "select the burst and type over it" is the only write path that
/// goes through the app's own editing pipeline and keeps its undo stack.
///
/// Four things about SendInput that the caller has to respect:
/// <list type="bullet">
/// <item>Input goes to whatever has keyboard focus *now*, not to a handle. The
///   caller must confirm the target process is still in the foreground.</item>
/// <item>UIPI blocks a non-elevated process from sending input to an elevated
///   window, silently — SendInput returns the count it accepted and the
///   keystrokes go nowhere. The write is verified by re-reading the field, so
///   this shows up as "not reflected" rather than as corruption.</item>
/// <item>The non-interleaving guarantee is per call. One call keeps its events
///   contiguous; a loop of calls does not, and a loop that fails partway
///   through leaves half a correction in the user's field. So everything here
///   is one call, and a write too long for one call is refused rather than
///   split. See <see cref="MaxKeyEvents"/>.</item>
/// <item>KEYEVENTF_UNICODE with wVk = 0 delivers the character directly, which
///   is what makes this work regardless of keyboard layout. Sending 'a' as a
///   virtual key on a Dvorak layout types something else.</item>
/// </list>
///
/// UNVERIFIED on real Windows.
/// </summary>
internal static class Keyboard
{
    /// <summary>
    /// The most key events one write may carry, and therefore the longest
    /// replacement the keystroke path will type.
    ///
    /// Each key event is a down and an up, so this is 2,000 INPUT records in a
    /// single call. The number matters much less than what it replaces: this
    /// used to send 400 records at a time and walk a longer array in a loop,
    /// which quietly gave up the one guarantee the comment above that loop was
    /// claiming, and made a half-written correction possible on any replacement
    /// over 200 characters. A write longer than this is now refused by the
    /// keystroke path and made through ValuePattern instead, which replaces the
    /// whole value in one call and so cannot half-finish. A dictated burst is a
    /// sentence; nothing near this length is one.
    /// </summary>
    internal const int MaxKeyEvents = 1000;

    /// <summary>True when a write of <paramref name="keyEvents"/> events fits in one call.</summary>
    internal static bool Fits(int keyEvents) => keyEvents >= 0 && keyEvents <= MaxKeyEvents;

    /// <summary>
    /// Types <paramref name="text"/> in one <c>SendInput</c> call and returns
    /// how many UTF-16 units of it Windows accepted: <c>text.Length</c> when all
    /// of it went, 0 when none did, and a count in between when the call was cut
    /// short. Surrogate pairs are two units and two events, which is what
    /// Windows expects — an emoji is two UTF-16 units and two INPUT records.
    ///
    /// The caller checks <see cref="Fits"/> first. A longer string returns 0
    /// rather than being split across calls.
    /// </summary>
    internal static int Type(string text) => Deliver(0, text);

    /// <summary>
    /// Deletes <paramref name="backspaces"/> characters and types
    /// <paramref name="text"/> in <b>one</b> <c>SendInput</c> call, and returns
    /// how many of the <c>backspaces + text.Length</c> key events landed.
    ///
    /// One call rather than two on purpose. The two-call form deleted the user's
    /// text and then made a second call that could fail on its own, which was
    /// the only ordering in this app that destroyed text before it had anything
    /// to put in its place.
    /// </summary>
    internal static int ReplaceTail(int backspaces, string text) => Deliver(backspaces, text);

    private static unsafe int Deliver(int backspaces, string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        if (backspaces < 0) return 0;

        int events = backspaces + text.Length;
        if (events == 0 || !Fits(events)) return 0;

        INPUT[] inputs = new INPUT[events * 2];
        int at = 0;
        for (int i = 0; i < backspaces; i++)
        {
            inputs[at++] = VirtualKeyInput(VIRTUAL_KEY.VK_BACK, up: false);
            inputs[at++] = VirtualKeyInput(VIRTUAL_KEY.VK_BACK, up: true);
        }

        for (int i = 0; i < text.Length; i++)
        {
            inputs[at++] = UnicodeInput(text[i], up: false);
            inputs[at++] = UnicodeInput(text[i], up: true);
        }

        uint sent;
        fixed (INPUT* buffer = inputs)
        {
            sent = PInvoke.SendInput((uint)inputs.Length, buffer, sizeof(INPUT));
        }

        // A key down and its key up are a pair, and a call cut off between them
        // left one unfinished. Rounding down calls that pair "did not land",
        // which is the conservative direction: the caller compares the field
        // against what this claims rather than trusting it, and a claim that
        // under-counts fails that comparison instead of splicing at an offset
        // one character off.
        return Math.Min(events, (int)(sent / 2));
    }

    private static INPUT UnicodeInput(char unit, bool up) => new()
    {
        type = INPUT_TYPE.INPUT_KEYBOARD,
        Anonymous = new INPUT._Anonymous_e__Union
        {
            ki = new KEYBDINPUT
            {
                wVk = 0,
                wScan = unit,
                dwFlags = up
                    ? KEYBD_EVENT_FLAGS.KEYEVENTF_UNICODE | KEYBD_EVENT_FLAGS.KEYEVENTF_KEYUP
                    : KEYBD_EVENT_FLAGS.KEYEVENTF_UNICODE,
                time = 0,
                dwExtraInfo = 0,
            },
        },
    };

    private static INPUT VirtualKeyInput(VIRTUAL_KEY key, bool up) => new()
    {
        type = INPUT_TYPE.INPUT_KEYBOARD,
        Anonymous = new INPUT._Anonymous_e__Union
        {
            ki = new KEYBDINPUT
            {
                wVk = key,
                wScan = 0,
                dwFlags = up ? KEYBD_EVENT_FLAGS.KEYEVENTF_KEYUP : 0,
                time = 0,
                dwExtraInfo = 0,
            },
        },
    };
}
