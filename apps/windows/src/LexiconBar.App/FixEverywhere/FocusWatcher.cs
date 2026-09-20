using System.Runtime.InteropServices;
using Windows.Win32.UI.Accessibility;

namespace LexiconBar.FixEverywhere;

/// <summary>
/// Follows the focused text field across every app, through UI Automation.
///
/// The macOS app creates one <c>AXObserver</c> per process. UIA is the other
/// way round: one global focus-changed handler covers the whole desktop, and
/// per-element handlers are attached to whatever currently has focus and torn
/// down when it moves. That is simpler, but it puts more weight on the poll,
/// because <c>Text_TextChanged</c> is the one UIA event providers are most
/// inconsistent about raising — Win32 Edit controls raise a value-property
/// change instead, and some Electron builds raise neither until the element is
/// queried.
///
/// So: focus change + TextChanged + ValueProperty change + a poll. Belt,
/// braces and a second pair of braces. The poll is what makes it work in
/// practice; the events are what make it fast in the apps that do raise them.
///
/// Callbacks run on the <see cref="UiaThread"/>.
///
/// UNVERIFIED on real Windows.
/// </summary>
internal sealed class FocusWatcher : IDisposable
{
    private readonly IUIAutomation _automation;
    private readonly UiaThread _thread;
    private readonly FocusHandler _focusHandler;
    private readonly TextChangedHandler _textHandler;
    private readonly PropertyChangedHandler _propertyHandler;

    private UiaField? _current;
    private string _lastValue = string.Empty;
    private bool _subscribed;
    private bool _polling;
    private int _pollMs = 250;
    private int _readLimit = 20_001;

    /// <summary>Called with the new focused field (or null) and its current value.</summary>
    internal Action<UiaField?, string>? FieldChanged { get; set; }

    /// <summary>Called on every observed or polled value change of the focused field.</summary>
    internal Action<UiaField, string>? ValueChanged { get; set; }

    /// <summary>The process name of whatever last had focus, for the tray menu. Read from any thread.</summary>
    internal volatile string FrontmostProcessName = string.Empty;

    internal FocusWatcher(IUIAutomation automation, UiaThread thread)
    {
        _automation = automation;
        _thread = thread;
        _focusHandler = new FocusHandler(this);
        _textHandler = new TextChangedHandler(this);
        _propertyHandler = new PropertyChangedHandler(this);
    }

    internal void Configure(int pollMs, int readLimit)
    {
        _thread.Post(() =>
        {
            _pollMs = Math.Clamp(pollMs, 60, 2000);
            _readLimit = Math.Max(1024, readLimit + 1);
        });
    }

    internal void Start()
    {
        _thread.Post(() =>
        {
            if (_subscribed) return;
            try
            {
                _automation.AddFocusChangedEventHandler(null, _focusHandler);
                _subscribed = true;
                Log.Info("focus watcher subscribed");
            }
            catch (COMException ex)
            {
                Log.Error($"could not subscribe to focus changes: {ex.Message}");
                return;
            }

            // Whatever has focus right now, before the first event arrives.
            RefreshFocusNow();
            StartPolling();
        });
    }

    internal void Stop()
    {
        _thread.Post(() =>
        {
            _polling = false;
            DetachFromCurrent();
            if (!_subscribed) return;
            try
            {
                _automation.RemoveFocusChangedEventHandler(_focusHandler);
            }
            catch (COMException)
            {
                // Nothing useful to do; the handler dies with the process.
            }

            _subscribed = false;
            SetCurrent(null, string.Empty);
        });
    }

    /// <summary>The engine wrote into the field; treat this as the value we already know about.</summary>
    internal void NoteValue(string value, UiaField field)
    {
        if (!field.SameElementAs(_current)) return;
        _lastValue = value;
    }

    internal UiaField? Current => _current;

    // ---------------------------------------------------------- UIA thread

    private void RefreshFocusNow()
    {
        IUIAutomationElement? element;
        try
        {
            element = _automation.GetFocusedElement();
        }
        catch (Exception ex) when (UiaField.IsProviderFailure(ex))
        {
            element = null;
        }

        HandleFocus(element);
    }

    private void HandleFocus(IUIAutomationElement? element)
    {
        if (element is null)
        {
            SetCurrent(null, string.Empty);
            return;
        }

        UiaField? field = UiaField.From(_automation, element);
        if (field is not null) FrontmostProcessName = field.ProcessName;
        if (field is null)
        {
            SetCurrent(null, string.Empty);
            return;
        }

        if (field.SameElementAs(_current)) return;

        string value = field.ReadValue(_readLimit) ?? string.Empty;
        SetCurrent(field, value);
    }

    private void SetCurrent(UiaField? field, string value)
    {
        DetachFromCurrent();
        _current = field;
        _lastValue = value;
        if (field is not null) AttachToCurrent(field);
        FieldChanged?.Invoke(field, value);
    }

    private void AttachToCurrent(UiaField field)
    {
        try
        {
            _automation.AddAutomationEventHandler(
                UIA_EVENT_ID.UIA_Text_TextChangedEventId,
                field.Element,
                TreeScope.TreeScope_Element,
                null,
                _textHandler);
        }
        catch (COMException ex)
        {
            Log.Info($"no TextChanged subscription in {field.ProcessName}: {ex.Message}");
        }

        try
        {
            unsafe
            {
                UIA_PROPERTY_ID[] properties = { UIA_PROPERTY_ID.UIA_ValueValuePropertyId };
                fixed (UIA_PROPERTY_ID* pointer = properties)
                {
                    _automation.AddPropertyChangedEventHandlerNativeArray(
                        field.Element,
                        TreeScope.TreeScope_Element,
                        null,
                        _propertyHandler,
                        pointer,
                        properties.Length);
                }
            }
        }
        catch (COMException ex)
        {
            Log.Info($"no ValueProperty subscription in {field.ProcessName}: {ex.Message}");
        }
    }

    private void DetachFromCurrent()
    {
        if (_current is null) return;
        try
        {
            _automation.RemoveAutomationEventHandler(
                UIA_EVENT_ID.UIA_Text_TextChangedEventId, _current.Element, _textHandler);
        }
        catch (Exception ex) when (UiaField.IsProviderFailure(ex))
        {
            // The element is usually already gone; that is why we are detaching.
        }

        try
        {
            _automation.RemovePropertyChangedEventHandler(_current.Element, _propertyHandler);
        }
        catch (Exception ex) when (UiaField.IsProviderFailure(ex))
        {
            // As above.
        }
    }

    private void StartPolling()
    {
        if (_polling) return;
        _polling = true;
        SchedulePoll();
    }

    private void SchedulePoll() => _thread.PostAfter(_pollMs / 1000.0, Poll);

    /// <summary>
    /// The safety net. Two jobs: notice a value change nobody raised an event
    /// for, and notice that focus moved to an app whose provider did not raise
    /// a focus-changed event either (which happens when an app is launched
    /// straight into a text field).
    /// </summary>
    private void Poll()
    {
        if (!_polling) return;
        try
        {
            if (_current is null)
            {
                RefreshFocusNow();
                return;
            }

            string? value = _current.ReadValue(_readLimit);
            if (value is null)
            {
                // The element stopped answering: it is gone. Re-resolve focus.
                SetCurrent(null, string.Empty);
                RefreshFocusNow();
                return;
            }

            if (value != _lastValue)
            {
                _lastValue = value;
                ValueChanged?.Invoke(_current, value);
            }
        }
        finally
        {
            if (_polling) SchedulePoll();
        }
    }

    private void NotifyValueChanged()
    {
        if (_current is not UiaField field) return;
        string? value = field.ReadValue(_readLimit);
        if (value is null || value == _lastValue) return;
        _lastValue = value;
        ValueChanged?.Invoke(field, value);
    }

    public void Dispose() => Stop();

    // ------------------------------------------------------- COM callbacks
    //
    // These run on a UI Automation thread. Microsoft's guidance is that a
    // client must not call back into UIA from inside one, so each does nothing
    // but hand the work to the UIA thread's queue.

    private sealed class FocusHandler : IUIAutomationFocusChangedEventHandler
    {
        private readonly FocusWatcher _watcher;

        internal FocusHandler(FocusWatcher watcher) => _watcher = watcher;

        public void HandleFocusChangedEvent(IUIAutomationElement sender) =>
            _watcher._thread.Post(() => _watcher.HandleFocus(sender));
    }

    private sealed class TextChangedHandler : IUIAutomationEventHandler
    {
        private readonly FocusWatcher _watcher;

        internal TextChangedHandler(FocusWatcher watcher) => _watcher = watcher;

        public void HandleAutomationEvent(IUIAutomationElement sender, UIA_EVENT_ID eventId) =>
            _watcher._thread.Post(_watcher.NotifyValueChanged);
    }

    private sealed class PropertyChangedHandler : IUIAutomationPropertyChangedEventHandler
    {
        private readonly FocusWatcher _watcher;

        internal PropertyChangedHandler(FocusWatcher watcher) => _watcher = watcher;

        public void HandlePropertyChangedEvent(
            IUIAutomationElement sender,
            UIA_PROPERTY_ID propertyId,
            object newValue) =>
            _watcher._thread.Post(_watcher.NotifyValueChanged);
    }
}
