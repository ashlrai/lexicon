using System.Diagnostics;
using System.Drawing;
using LexiconBar.Interop;
using Windows.Win32;
using Windows.Win32.Foundation;
using Windows.Win32.UI.Accessibility;
using Windows.Win32.UI.WindowsAndMessaging;

namespace LexiconBar.FixEverywhere;

/// <summary>
/// One focused text field, seen through UI Automation. Everything here runs on
/// the <see cref="UiaThread"/>.
///
/// The macOS counterpart is <c>AXSupport.swift</c>. The differences that matter:
///
/// <list type="bullet">
/// <item>UIA's <c>TextPattern</c> is <b>read-only</b>. There is no equivalent of
///   setting <c>AXSelectedText</c>, so the primary write is "select the span
///   through TextPattern, then type over it with SendInput". The whole-value
///   write through <c>ValuePattern</c> is the fallback, not the other way
///   round, because it loses the app's undo stack.</item>
/// <item>A <c>TextPatternRange</c> has no offsets. Turning one into a UTF-16
///   position means cloning the document range, dragging an endpoint to the
///   range you care about, and measuring the text in between.</item>
/// <item><c>TextUnit_Character</c> is defined by the provider, not by us. Most
///   map it to one UTF-16 unit; some map it to a grapheme. Every range this
///   class builds is therefore read back and compared against the text it is
///   supposed to cover before anything is written through it.</item>
/// </list>
///
/// UNVERIFIED: none of this has been run against a real provider.
/// </summary>
internal sealed class UiaField : IInspectableField
{
    private readonly IUIAutomation _automation;

    internal IUIAutomationElement Element { get; }

    /// <summary>Stable identity, used for rate limiting and for the undo ledger.</summary>
    internal string Key { get; }

    internal int ProcessId { get; }

    internal string ProcessName { get; }

    internal string AppName { get; }

    /// <summary>
    /// This field's own labels and those of its window. Captured here, once,
    /// because <see cref="FieldGate"/> needs them on every poll to decide
    /// whether the value may be read — and because they are metadata, which is
    /// exactly what may be looked at before that decision is made.
    /// </summary>
    internal FieldHints Hints { get; }

    private UiaField(
        IUIAutomation automation,
        IUIAutomationElement element,
        string key,
        int processId,
        string processName,
        string appName,
        FieldHints hints)
    {
        _automation = automation;
        Element = element;
        Key = key;
        ProcessId = processId;
        ProcessName = processName;
        AppName = appName;
        Hints = hints;
    }

    // The gate's view of this field: identity and labels for free, the value
    // only through the one call it guards. Explicit implementations so the
    // class keeps its `internal` surface for everything else.
    string IInspectableField.Key => Key;

    string IInspectableField.ProcessName => ProcessName;

    FieldHints IInspectableField.Hints => Hints;

    string? IInspectableField.ReadValue(int limit) => ReadValue(limit);

    /// <summary>
    /// Builds a field from a focused element, or returns null when it is not
    /// something we are willing to watch at all.
    ///
    /// Nothing here reads the field's <i>value</i>: only UIA's own metadata,
    /// which is what <see cref="FieldGate"/> then decides on. A masked input is
    /// refused outright, because there is no case in which we want one; every
    /// other refusal (an excluded app, a secret-looking label) belongs to the
    /// gate, which the watcher consults before its first
    /// <see cref="ReadValue"/>.
    /// </summary>
    internal static UiaField? From(IUIAutomation automation, IUIAutomationElement element)
    {
        try
        {
            // A masked input, full stop. This is UIA's own answer and it is the
            // cheapest check available, so it goes first.
            bool isPassword = element.CurrentIsPassword;
            if (isPassword)
            {
                Log.Info("not watching this field: UIA reports IsPassword");
                return null;
            }

            UIA_CONTROLTYPE_ID controlType = element.CurrentControlType;
            bool editable = controlType is UIA_CONTROLTYPE_ID.UIA_EditControlTypeId
                                        or UIA_CONTROLTYPE_ID.UIA_DocumentControlTypeId
                                        or UIA_CONTROLTYPE_ID.UIA_ComboBoxControlTypeId;
            bool hasText = IsTrue(element, UIA_PROPERTY_ID.UIA_IsTextPatternAvailablePropertyId);
            bool hasValue = IsTrue(element, UIA_PROPERTY_ID.UIA_IsValuePatternAvailablePropertyId);
            if (!editable && !hasText && !hasValue) return null;
            if (!hasText && !hasValue) return null;

            int processId = element.CurrentProcessId;
            string processName = ProcessNameFor(processId);
            string windowTitle = WindowTitleFor(automation, element) ?? string.Empty;

            FieldHints hints = new(
                Identifier: Bstr.Consume(element.CurrentAutomationId),
                Placeholder: Bstr.Consume(element.CurrentHelpText),
                Title: Bstr.Consume(element.CurrentName),
                RoleDescription: Bstr.Consume(element.CurrentLocalizedControlType),
                Help: null,
                Description: StringProperty(element, UIA_PROPERTY_ID.UIA_FullDescriptionPropertyId),
                ClassName: Bstr.Consume(element.CurrentClassName),
                WindowTitle: windowTitle);

            // The process name is what the exclusion list matches on and what
            // the user sees in the menu; the window title is only a hint for
            // the secret heuristic and changes as the user works.
            string appName = processName;
            string key = KeyFor(element, processId);
            return new UiaField(automation, element, key, processId, processName, appName, hints);
        }
        catch (Exception ex) when (IsProviderFailure(ex))
        {
            return null;
        }
    }

    // ------------------------------------------------------------------ read

    /// <summary>
    /// The field's current text, or null when it cannot be read.
    /// <paramref name="limit"/> caps how much is pulled across the process
    /// boundary — a burst in a 2 MB document is refused anyway, so there is no
    /// reason to marshal the whole thing on every poll. One extra unit is
    /// fetched so "too long" is still distinguishable from "exactly the limit".
    /// </summary>
    internal string? ReadValue(int limit)
    {
        try
        {
            if (TextPattern() is IUIAutomationTextPattern text)
            {
                string? value = Bstr.Consume(text.DocumentRange.GetText(limit + 1));
                if (value is not null) return value;
            }

            if (ValuePattern() is IUIAutomationValuePattern value2)
            {
                return Bstr.Consume(value2.CurrentValue);
            }
        }
        catch (Exception ex) when (IsProviderFailure(ex))
        {
            return null;
        }

        return null;
    }

    /// <summary>
    /// Where the insertion point sits, as a UTF-16 offset into the field. This
    /// is what turns an ambiguous burst window into an anchored one, so it is
    /// worth the three extra cross-process calls.
    ///
    /// Null when the provider exposes no selection (Chromium sometimes answers
    /// an empty array while the page is still laying out), in which case the
    /// detector refuses an ambiguous insertion rather than guessing. Null too
    /// when the caret sits further into the document than <paramref name="limit"/>:
    /// this is a read like any other, so it takes the same cap, and an offset
    /// measured from truncated text would be a wrong number rather than a
    /// missing one.
    /// </summary>
    internal int? CaretEnd(int limit)
    {
        try
        {
            if (TextPattern() is not IUIAutomationTextPattern text) return null;
            IUIAutomationTextRangeArray selection = text.GetSelection();
            if (selection is null || selection.Length < 1) return null;

            IUIAutomationTextRange caret = selection.GetElement(0);
            if (StartOffsetOf(text, caret, limit) is not int start) return null;

            int selected = (Bstr.Consume(caret.GetText(limit + 1)) ?? string.Empty).Length;
            if (selected > limit) return null;

            return start + selected;
        }
        catch (Exception ex) when (IsProviderFailure(ex))
        {
            return null;
        }
    }

    /// <summary>
    /// Where <paramref name="range"/> starts, as a UTF-16 offset into the
    /// document. A <c>TextPatternRange</c> carries no offsets, so the only way
    /// to ask is to clone the document range, drag its End back to this range's
    /// Start, and measure what is left in front.
    ///
    /// That measurement is a read of the user's text, so it is capped like
    /// every other one. A probe that comes back at the cap was truncated and
    /// its length is no longer the offset, so this answers null rather than a
    /// number it cannot stand behind.
    /// </summary>
    private static int? StartOffsetOf(IUIAutomationTextPattern text, IUIAutomationTextRange range, int limit)
    {
        IUIAutomationTextRange probe = text.DocumentRange.Clone();
        probe.MoveEndpointByRange(
            TextPatternRangeEndpoint.TextPatternRangeEndpoint_End,
            range,
            TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start);

        int length = (Bstr.Consume(probe.GetText(limit + 1)) ?? string.Empty).Length;
        return length > limit ? null : length;
    }

    /// <summary>
    /// The caret rectangle in screen pixels, for placing the bubble. Tries the
    /// selection's bounding rectangles first (works in Chromium and WinUI), then
    /// the Win32 caret, then the element's own box.
    /// </summary>
    internal Rectangle? CaretRect()
    {
        try
        {
            if (TextPattern() is IUIAutomationTextPattern text)
            {
                IUIAutomationTextRangeArray selection = text.GetSelection();
                if (selection is not null && selection.Length >= 1)
                {
                    double[] quads = ReadBoundingRectangles(selection.GetElement(0));
                    // {left, top, width, height} per rectangle; a collapsed caret
                    // legitimately has width 0, which is still a usable anchor.
                    if (quads.Length >= 4)
                    {
                        return new Rectangle(
                            (int)quads[0],
                            (int)quads[1],
                            Math.Max(1, (int)quads[2]),
                            Math.Max(1, (int)quads[3]));
                    }
                }
            }
        }
        catch (Exception ex) when (IsProviderFailure(ex))
        {
            // fall through
        }

        if (Win32Caret() is Rectangle win32) return win32;

        try
        {
            RECT box = Element.CurrentBoundingRectangle;
            if (box.right > box.left && box.bottom > box.top)
            {
                return new Rectangle(box.left, box.top, box.right - box.left, box.bottom - box.top);
            }
        }
        catch (Exception ex) when (IsProviderFailure(ex))
        {
            // fall through
        }

        return null;
    }

    private static unsafe double[] ReadBoundingRectangles(IUIAutomationTextRange range) =>
        SafeArrays.ConsumeDouble(range.GetBoundingRectangles());

    private static unsafe Rectangle? Win32Caret()
    {
        GUITHREADINFO info = new() { cbSize = (uint)sizeof(GUITHREADINFO) };
        if (!PInvoke.GetGUIThreadInfo(0, &info)) return null;
        if (info.hwndCaret.IsNull) return null;
        RECT caret = info.rcCaret;
        if (caret.right <= caret.left && caret.bottom <= caret.top) return null;

        System.Drawing.Point topLeft = new(caret.left, caret.top);
        if (!PInvoke.ClientToScreen(info.hwndCaret, ref topLeft)) return null;
        return new Rectangle(
            topLeft.X,
            topLeft.Y,
            Math.Max(1, caret.right - caret.left),
            Math.Max(1, caret.bottom - caret.top));
    }

    // ----------------------------------------------------------------- write

    /// <summary>
    /// Selects <paramref name="span"/> and confirms the provider means the same
    /// thing by it. Returns false without having selected anything the caller
    /// can rely on when the round trip does not come back holding
    /// <paramref name="expected"/>.
    ///
    /// This is the Windows form of the macOS check "does the app mean the same
    /// span we do?". A range that lands even one unit off would splice the
    /// correction into the middle of a word.
    /// </summary>
    internal bool SelectSpan(TextSpan span, string expected, int documentLength)
    {
        try
        {
            if (TextPattern() is not IUIAutomationTextPattern text) return false;
            if (text.SupportedTextSelection == SupportedTextSelection.SupportedTextSelection_None) return false;

            IUIAutomationTextRange range = text.DocumentRange.Clone();
            if (span.Location > 0)
            {
                int moved = range.MoveEndpointByUnit(
                    TextPatternRangeEndpoint.TextPatternRangeEndpoint_Start,
                    TextUnit.TextUnit_Character,
                    span.Location);
                if (moved != span.Location) return false;
            }

            int tail = documentLength - span.End;
            if (tail > 0)
            {
                int moved = range.MoveEndpointByUnit(
                    TextPatternRangeEndpoint.TextPatternRangeEndpoint_End,
                    TextUnit.TextUnit_Character,
                    -tail);
                if (moved != -tail) return false;
            }

            // The provider's idea of "character" is not necessarily ours. One
            // unit past `expected` is enough to tell "the same" from "longer",
            // and it keeps this from pulling a whole document across when a
            // range lands somewhere other than where it was aimed.
            if (Bstr.Consume(range.GetText(expected.Length + 1)) != expected) return false;

            range.Select();

            // And confirm the selection actually took: some Chromium builds
            // apply it asynchronously and some read-only views ignore it.
            return SelectionHolds(text, expected);
        }
        catch (Exception ex) when (IsProviderFailure(ex))
        {
            return false;
        }
    }

    private static bool SelectionHolds(IUIAutomationTextPattern text, string expected)
    {
        for (int attempt = 0; attempt < 12; attempt++)
        {
            try
            {
                IUIAutomationTextRangeArray selection = text.GetSelection();
                if (selection is not null && selection.Length >= 1
                    && Bstr.Consume(selection.GetElement(0).GetText(expected.Length + 1)) == expected)
                {
                    return true;
                }
            }
            catch (Exception ex) when (IsProviderFailure(ex))
            {
                return false;
            }

            Thread.Sleep(25);
        }

        return false;
    }

    /// <summary>
    /// True when the field's selection is, right now, exactly
    /// <paramref name="span"/> holding <paramref name="expected"/>.
    ///
    /// <see cref="SelectSpan"/> proves the selection took, but proving it costs
    /// round trips, and between the last of those and the <c>SendInput</c> that
    /// types over the selection there is a gap the user's own input can land
    /// in. Home, End, an arrow key or a click elsewhere in the same field moves
    /// or collapses the selection <b>without changing the field's text</b>, so
    /// the caller's "is the whole value still what the plan was made from?"
    /// check passes and the correction is typed wherever the caret went.
    ///
    /// So the caller asks this immediately before typing. It compares the
    /// position as well as the text: in "add the item, add the item" the two
    /// halves are textually identical, and a selection that slid from one to
    /// the other would pass a text-only comparison.
    ///
    /// This narrows the window to the one call it cannot cover. A single
    /// <c>SendInput</c> is non-interleaving, so nothing can land between this
    /// check and the keystrokes except in the microseconds it takes to issue
    /// them — which is true of <i>one</i> call and was not true of the loop of
    /// them this used to sit in front of. <c>Keyboard.MaxKeyEvents</c> is what
    /// keeps it one call.
    /// </summary>
    internal bool SelectionMatches(TextSpan span, string expected, int limit)
    {
        try
        {
            if (TextPattern() is not IUIAutomationTextPattern text) return false;

            IUIAutomationTextRangeArray selection = text.GetSelection();
            // Exactly one range: a provider answering several (a table, a
            // multi-caret editor) is not a state to type into.
            if (selection is null || selection.Length != 1) return false;

            IUIAutomationTextRange range = selection.GetElement(0);
            if (Bstr.Consume(range.GetText(expected.Length + 1)) != expected) return false;

            return StartOffsetOf(text, range, limit) == span.Location;
        }
        catch (Exception ex) when (IsProviderFailure(ex))
        {
            return false;
        }
    }

    /// <summary>The whole-value write. Null when there is no writable ValuePattern.</summary>
    internal bool SetWholeValue(string value)
    {
        try
        {
            if (ValuePattern() is not IUIAutomationValuePattern pattern) return false;
            if (pattern.CurrentIsReadOnly) return false;

            BSTR bstr = Bstr.Allocate(value);
            try
            {
                pattern.SetValue(bstr);
            }
            finally
            {
                Bstr.Free(bstr);
            }

            return true;
        }
        catch (Exception ex) when (IsProviderFailure(ex))
        {
            return false;
        }
    }

    internal bool HasWritableValuePattern()
    {
        try
        {
            return ValuePattern() is IUIAutomationValuePattern pattern && !pattern.CurrentIsReadOnly;
        }
        catch (Exception ex) when (IsProviderFailure(ex))
        {
            return false;
        }
    }

    /// <summary>Re-reads the field until it holds <paramref name="expected"/> or <paramref name="seconds"/> pass.</summary>
    internal bool Verify(string expected, double seconds, int limit)
    {
        Stopwatch clock = Stopwatch.StartNew();
        while (true)
        {
            if (ReadValue(limit) == expected) return true;
            if (clock.Elapsed.TotalSeconds >= seconds) return false;
            Thread.Sleep(25);
        }
    }

    /// <summary>
    /// True when this field's process owns the foreground window. Synthesized
    /// input goes wherever keyboard focus is, so nothing may be typed unless
    /// that is still here.
    /// </summary>
    internal bool IsForeground()
    {
        unsafe
        {
            HWND foreground = PInvoke.GetForegroundWindow();
            if (foreground.IsNull) return false;
            uint pid = 0;
            PInvoke.GetWindowThreadProcessId(foreground, &pid);
            return pid == (uint)ProcessId;
        }
    }

    internal bool SameElementAs(UiaField? other)
    {
        if (other is null) return false;
        try
        {
            return _automation.CompareElements(Element, other.Element);
        }
        catch (Exception ex) when (IsProviderFailure(ex))
        {
            return Key == other.Key;
        }
    }

    // ---------------------------------------------------------------- detail

    private IUIAutomationTextPattern? TextPattern() =>
        Element.GetCurrentPattern(UIA_PATTERN_ID.UIA_TextPatternId) as IUIAutomationTextPattern;

    private IUIAutomationValuePattern? ValuePattern() =>
        Element.GetCurrentPattern(UIA_PATTERN_ID.UIA_ValuePatternId) as IUIAutomationValuePattern;

    private static bool IsTrue(IUIAutomationElement element, UIA_PROPERTY_ID property)
    {
        try
        {
            return element.GetCurrentPropertyValue(property) is bool value && value;
        }
        catch (Exception ex) when (IsProviderFailure(ex))
        {
            return false;
        }
    }

    private static string? StringProperty(IUIAutomationElement element, UIA_PROPERTY_ID property)
    {
        try
        {
            return element.GetCurrentPropertyValue(property) as string;
        }
        catch (Exception ex) when (IsProviderFailure(ex))
        {
            return null;
        }
    }

    private static unsafe string KeyFor(IUIAutomationElement element, int processId)
    {
        try
        {
            int[] runtimeId = SafeArrays.ConsumeInt32(element.GetRuntimeId());
            if (runtimeId.Length > 0) return string.Join('.', runtimeId);
        }
        catch (Exception ex) when (IsProviderFailure(ex))
        {
            // fall through
        }

        // No runtime id (rare, but providers may refuse). A per-process
        // fallback is coarse, and the consequence is only that undo may be
        // offered for the wrong field — which the text comparison then refuses.
        return $"pid:{processId}";
    }

    private static string ProcessNameFor(int processId)
    {
        try
        {
            return Process.GetProcessById(processId).ProcessName;
        }
        catch (Exception ex) when (ex is ArgumentException or InvalidOperationException)
        {
            return $"pid {processId}";
        }
    }

    private static unsafe string? WindowTitleFor(IUIAutomation automation, IUIAutomationElement element)
    {
        try
        {
            HWND hwnd = element.CurrentNativeWindowHandle;
            if (hwnd.IsNull) hwnd = PInvoke.GetForegroundWindow();
            if (hwnd.IsNull) return null;

            HWND root = PInvoke.GetAncestor(hwnd, GET_ANCESTOR_FLAGS.GA_ROOT);
            if (root.IsNull) root = hwnd;
            return Bstr.Consume(automation.ElementFromHandle(root).CurrentName);
        }
        catch (Exception ex) when (IsProviderFailure(ex))
        {
            return null;
        }
    }

    /// <summary>
    /// The exceptions a UIA provider can throw at any moment: the app quit, the
    /// element was destroyed, the call timed out, the provider is busy. None of
    /// them is a bug here and none should take the watcher down.
    /// </summary>
    internal static bool IsProviderFailure(Exception ex) =>
        ex is System.Runtime.InteropServices.COMException
           or System.Runtime.InteropServices.InvalidComObjectException
           or InvalidCastException
           or UnauthorizedAccessException
           or TimeoutException
           or NullReferenceException;
}
