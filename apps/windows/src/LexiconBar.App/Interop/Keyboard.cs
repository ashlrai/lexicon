using Windows.Win32;
using Windows.Win32.UI.Input.KeyboardAndMouse;

namespace LexiconBar.Interop;

/// <summary>
/// Synthesized keystrokes, which on Windows is the *primary* way a correction
/// gets written, not the last resort it is on macOS: UIA's TextPattern has no
/// setter, so "select the burst and type over it" is the only write path that
/// goes through the app's own editing pipeline and keeps its undo stack.
///
/// Three things about SendInput that the caller has to respect:
/// <list type="bullet">
/// <item>Input goes to whatever has keyboard focus *now*, not to a handle. The
///   caller must confirm the target process is still in the foreground.</item>
/// <item>UIPI blocks a non-elevated process from sending input to an elevated
///   window, silently — SendInput returns the count it accepted and the
///   keystrokes go nowhere. The write is verified by re-reading the field, so
///   this shows up as "not reflected" rather than as corruption.</item>
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
    /// Types <paramref name="text"/> as Unicode key events. Surrogate pairs are
    /// sent as two events, which is what Windows expects — an emoji is two
    /// UTF-16 units and two INPUT records.
    /// </summary>
    internal static bool Type(string text)
    {
        if (text.Length == 0) return true;

        INPUT[] inputs = new INPUT[text.Length * 2];
        for (int i = 0; i < text.Length; i++)
        {
            inputs[i * 2] = UnicodeInput(text[i], up: false);
            inputs[(i * 2) + 1] = UnicodeInput(text[i], up: true);
        }

        return Send(inputs);
    }

    /// <summary>Presses and releases a virtual key <paramref name="count"/> times.</summary>
    internal static bool Press(VIRTUAL_KEY key, int count = 1)
    {
        if (count <= 0) return true;

        INPUT[] inputs = new INPUT[count * 2];
        for (int i = 0; i < count; i++)
        {
            inputs[i * 2] = VirtualKeyInput(key, up: false);
            inputs[(i * 2) + 1] = VirtualKeyInput(key, up: true);
        }

        return Send(inputs);
    }

    private static unsafe bool Send(INPUT[] inputs)
    {
        // One SendInput call per batch: the documentation is explicit that a
        // single call keeps the events contiguous, so nothing the user types
        // can interleave into the middle of a correction.
        const int Batch = 400;
        fixed (INPUT* buffer = inputs)
        {
            int offset = 0;
            while (offset < inputs.Length)
            {
                int count = Math.Min(Batch, inputs.Length - offset);
                uint sent = PInvoke.SendInput((uint)count, buffer + offset, sizeof(INPUT));
                if (sent != (uint)count) return false;
                offset += count;
            }
        }

        return true;
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
