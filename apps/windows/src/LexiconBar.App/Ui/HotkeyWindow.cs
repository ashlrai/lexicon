using System.Windows.Forms;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.UI.Input.KeyboardAndMouse;

namespace LexiconBar.Ui;

/// <summary>
/// A message-only window holding the two global hotkeys, matching the Mac app's
/// Ctrl+Alt+Z (undo the last fix) and Ctrl+Alt+V (fix the clipboard).
///
/// <c>RegisterHotKey</c> fails rather than stealing a combination another app
/// already owns, which is the behaviour we want: a hotkey that quietly took
/// over somebody's IDE shortcut would be worse than no hotkey. A failure is
/// logged and the menu items still work.
/// </summary>
internal sealed class HotkeyWindow : NativeWindow, IDisposable
{
    private const int WM_HOTKEY = 0x0312;
    private const int IdUndo = 0xA101;
    private const int IdFixClipboard = 0xA102;

    private bool _undoRegistered;
    private bool _clipboardRegistered;

    internal Action? UndoPressed { get; set; }

    internal Action? FixClipboardPressed { get; set; }

    internal HotkeyWindow()
    {
        CreateHandle(new CreateParams
        {
            Caption = "LexiconBarHotkeys",
            // HWND_MESSAGE: a window that exists only to receive messages.
            Parent = new IntPtr(-3),
        });

        HOT_KEY_MODIFIERS modifiers = HOT_KEY_MODIFIERS.MOD_CONTROL
                                      | HOT_KEY_MODIFIERS.MOD_ALT
                                      | HOT_KEY_MODIFIERS.MOD_NOREPEAT;

        _undoRegistered = PInvoke.RegisterHotKey(new HWND(Handle), IdUndo, modifiers, (uint)VIRTUAL_KEY.VK_Z);
        if (!_undoRegistered) Log.Warn("could not register Ctrl+Alt+Z; something else owns it");

        _clipboardRegistered = PInvoke.RegisterHotKey(new HWND(Handle), IdFixClipboard, modifiers, (uint)VIRTUAL_KEY.VK_V);
        if (!_clipboardRegistered) Log.Warn("could not register Ctrl+Alt+V; something else owns it");
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WM_HOTKEY)
        {
            switch (message.WParam.ToInt32())
            {
                case IdUndo:
                    UndoPressed?.Invoke();
                    return;

                case IdFixClipboard:
                    FixClipboardPressed?.Invoke();
                    return;
            }
        }

        base.WndProc(ref message);
    }

    public void Dispose()
    {
        if (Handle != IntPtr.Zero)
        {
            if (_undoRegistered) PInvoke.UnregisterHotKey(new HWND(Handle), IdUndo);
            if (_clipboardRegistered) PInvoke.UnregisterHotKey(new HWND(Handle), IdFixClipboard);
        }

        _undoRegistered = false;
        _clipboardRegistered = false;
        DestroyHandle();
    }
}
