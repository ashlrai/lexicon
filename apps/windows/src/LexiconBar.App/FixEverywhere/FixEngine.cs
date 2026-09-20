using System.Drawing;
using LexiconBar.Interop;
using Windows.Win32.UI.Input.KeyboardAndMouse;

namespace LexiconBar.FixEverywhere;

/// <summary>
/// "Fix everywhere": watches the focused field, turns dictation-sized
/// insertions into bursts, normalizes them through the local API and writes the
/// corrected span back.
///
/// All state lives on the <see cref="UiaThread"/>. <see cref="Config"/> is
/// pushed from the UI thread with <see cref="Update"/>; results come back on
/// the UI thread through <see cref="Event"/>.
///
/// The decision logic is shared with the Mac app through the tested core; what
/// is different, and untested, is the write ladder — see <see cref="Write"/>.
/// </summary>
internal sealed class FixEngine
{
    internal sealed record Config
    {
        internal bool Enabled { get; init; } = true;

        internal BurstDetector.Config Detector { get; init; } = BurstDetector.Config.Default;

        internal AppExclusions Exclusions { get; init; } = new();

        /// <summary>One API call per element per this many seconds.</summary>
        internal double RateLimitSeconds { get; init; } = 0.3;
    }

    internal sealed record Fix(
        string AppName,
        string ProcessName,
        IReadOnlyList<FixReplacement> Replacements,
        string Summary,
        string Strategy,
        int ElapsedMs,
        Rectangle? Caret);

    internal abstract record Event
    {
        internal sealed record Fixed(Fix Fix) : Event;

        internal sealed record Undone(string AppName) : Event;

        internal sealed record Skipped(string Why) : Event;

        internal sealed record Failed(string Why) : Event;

        internal sealed record UndoAvailable(bool Available) : Event;
    }

    /// <summary>Raised on the UI thread.</summary>
    internal Action<Event>? OnEvent { get; set; }

    private readonly UiaThread _thread;
    private readonly FocusWatcher _watcher;
    private readonly NormalizeClient _client;
    private readonly SynchronizationContext _ui;

    private Config _config = new();
    private BurstDetector? _detector;
    private UiaField? _field;
    private int _settleGeneration;
    private readonly Dictionary<string, double> _lastRequestAt = new(StringComparer.Ordinal);
    private bool _inFlight;
    private readonly UndoLedger _undo = new();
    private bool _undoWasAvailable;

    internal FixEngine(UiaThread thread, FocusWatcher watcher, NormalizeClient client, SynchronizationContext ui)
    {
        _thread = thread;
        _watcher = watcher;
        _client = client;
        _ui = ui;
        watcher.FieldChanged = FieldChanged;
        watcher.ValueChanged = ValueChanged;
    }

    /// <summary>The last correction, for the tray's "Last correction" submenu. UI thread.</summary>
    internal Fix? LastFix { get; private set; }

    // --------------------------------------------------------- UI thread API

    internal void Update(Config config)
    {
        _thread.Post(() =>
        {
            bool wasEnabled = _config.Enabled;
            _config = config;
            if (_detector is not null) _detector.Settings = config.Detector;

            if (wasEnabled && !config.Enabled)
            {
                _detector = null;
                _settleGeneration++;
            }
            else if (!wasEnabled && config.Enabled && _field is UiaField field)
            {
                // Refusal first, read second: the new config may be the one
                // that excludes this very app.
                _detector = Refusal(field) is string why
                    ? Refuse(field, why)
                    : new BurstDetector(field.ReadValue(ReadLimit) ?? string.Empty, config.Detector);
            }
        });
    }

    /// <summary>Ctrl+Alt+Z, the menu and the bubble's Undo all land here.</summary>
    internal void UndoLast() => _thread.Post(PerformUndo);

    private int ReadLimit => _config.Detector.MaxFieldLength + 1;

    // ------------------------------------------------------------ UIA thread

    private void FieldChanged(UiaField? field, string value)
    {
        _field = field;
        _settleGeneration++;
        _detector = field is null ? null : MakeDetector(field, value);
        PublishUndoAvailability(value);
    }

    /// <summary>
    /// A detector, unless this field is one we refuse outright.
    ///
    /// This is <b>defence in depth, not the guard itself</b>. The guard is in
    /// <see cref="FocusWatcher"/>, which consults <see cref="FieldGate"/> before
    /// it reads anything, so a refused field's text never reaches this class to
    /// begin with — a value handed to this method has already been admitted.
    /// What this check buys is the case where the two disagree: the engine's
    /// config and the watcher's are pushed separately, so for the width of one
    /// settings change the engine may hold a list the watcher has not got yet.
    /// Refusing here too means the newer of the two always wins.
    ///
    /// The same check runs once more in <see cref="Handle"/>, immediately before
    /// anything is sent to the local API.
    /// </summary>
    private BurstDetector? MakeDetector(UiaField field, string value) =>
        Refusal(field) is string why ? Refuse(field, why) : new BurstDetector(value, _config.Detector);

    /// <summary>
    /// Why this field is one we will not act on, or null. The same call the
    /// watcher gates its reads with, against this class's copy of the config.
    /// </summary>
    private string? Refusal(UiaField field) =>
        FieldGate.Refuse(_config.Exclusions, field.ProcessName, field.Hints);

    /// <summary>Logs the refusal and hands back "no detector", so callers read as one expression.</summary>
    private static BurstDetector? Refuse(UiaField field, string why)
    {
        Log.Info($"not watching this field in {field.ProcessName}: {why}");
        return null;
    }

    private void ValueChanged(UiaField field, string value)
    {
        if (!_config.Enabled || !field.SameElementAs(_field) || _detector is not BurstDetector detector) return;

        detector.Record(value, _thread.Now);
        PublishUndoAvailability(value);
        if (!detector.HasPendingChanges) return;

        _settleGeneration++;
        int generation = _settleGeneration;
        _thread.PostAfter((_config.Detector.SettleMs / 1000.0) + 0.01, () =>
        {
            if (generation != _settleGeneration) return;
            Settle();
        });
    }

    private void Settle()
    {
        if (!_config.Enabled || _detector is not BurstDetector detector || _field is not UiaField field) return;

        // Where the caret is now tells the detector which of several textually
        // identical windows actually arrived. Without it, dictation in front of
        // text that starts the same way is located several units late.
        int? caretEnd = field.CaretEnd();

        switch (detector.Settle(_thread.Now, caretEnd))
        {
            case SettleOutcome.Waiting:
                // A change landed after the timer was armed; the newer timer fires.
                return;

            case SettleOutcome.Coalescing:
                // Dictation is still streaming in. Nothing was decided and the
                // detector kept the run pending, so ask again shortly — no value
                // change is coming to re-arm the timer if the user stopped
                // speaking mid-run.
                _settleGeneration++;
                int generation = _settleGeneration;
                _thread.PostAfter(0.25, () =>
                {
                    if (generation != _settleGeneration) return;
                    Settle();
                });
                return;

            case SettleOutcome.Skipped skipped:
                Log.Info($"skip in {field.ProcessName}: {skipped.Reason}");
                return;

            case SettleOutcome.Fired fired:
                Handle(fired.Burst, field);
                return;
        }
    }

    private void Handle(Burst burst, UiaField field)
    {
        // The last of the three checks, and the one that matters most: this is
        // the call that would put the text on the wire. Nothing about the burst
        // is logged or sent when it refuses.
        if (Refusal(field) is string why)
        {
            Log.Info($"skip in {field.ProcessName}: {why}");
            return;
        }

        if (_lastRequestAt.TryGetValue(field.Key, out double last) && _thread.Now - last < _config.RateLimitSeconds)
        {
            Log.Info("skip: rate limit");
            return;
        }

        if (_inFlight)
        {
            Log.Info("skip: request in flight");
            return;
        }

        _lastRequestAt[field.Key] = _thread.Now;
        _inFlight = true;
        double started = _thread.Now;

        _ = Task.Run(async () =>
        {
            NormalizeClient.Result result = await _client.NormalizeAsync(burst.Text).ConfigureAwait(false);
            _thread.Post(() =>
            {
                _inFlight = false;
                if (result.Response is NormalizeResponse response)
                {
                    Apply(burst, response, field, started);
                }
                else
                {
                    Report(new Event.Failed(result.Failure?.Description ?? "Local API call failed."));
                }
            });
        });
    }

    private void Apply(Burst burst, NormalizeResponse response, UiaField field, double started)
    {
        if (!_config.Enabled || !field.SameElementAs(_field) || _detector is not BurstDetector detector) return;

        // The API round trip is the longest gap in the flow, and the user can
        // exclude this app from the tray menu while it is open. Do not read the
        // field, and do not write into it, if they did.
        if (Refusal(field) is string why)
        {
            Log.Info($"skip in {field.ProcessName}: {why}");
            return;
        }

        string current = field.ReadValue(ReadLimit) ?? string.Empty;
        RewriteDecision decision = RewritePlanner.Make(
            burst, response, current, _config.Detector.MaxFieldLength);

        if (decision.Plan is not RewritePlan plan)
        {
            if (decision.Refusal != RewriteRefusal.Unchanged) Log.Info($"refused: {decision.Refusal}");
            return;
        }

        (string? strategy, string detail) = Write(plan, field, before: current);
        if (strategy is null)
        {
            Report(new Event.Failed($"Could not write into {field.AppName}: {detail}"));
            return;
        }

        detector.MarkStable(plan.SplicedFullText);
        _watcher.NoteValue(plan.SplicedFullText, field);
        _undo.Record(new UndoLedger.Entry(
            field.Key, plan.Span, plan.NewText, plan.PreviousText, plan.SplicedFullText));
        PublishUndoAvailability(plan.SplicedFullText, force: true);

        // Read the caret here, on the UIA thread, right after the write: the UI
        // thread must never make a cross-process UIA call.
        Fix fix = new(
            AppName: field.AppName,
            ProcessName: field.ProcessName,
            Replacements: response.Replacements,
            Summary: response.Summary,
            Strategy: strategy,
            ElapsedMs: (int)((_thread.Now - started) * 1000),
            Caret: field.CaretRect());

        Report(new Event.Fixed(fix));
    }

    /// <summary>
    /// Two strategies, each verified by re-reading the field, and a third that
    /// is deliberately narrow.
    ///
    /// <list type="number">
    /// <item><b>Select and type.</b> Select the burst span through
    ///   <c>TextPattern</c>, confirm the provider agrees about what that span
    ///   holds, confirm the app is still in the foreground, confirm the
    ///   selection is <i>still</i> that exact span, then send the replacement as
    ///   Unicode key events. This goes through the app's own
    ///   editing path, so its undo stack, autocomplete and change events all
    ///   behave as if the user had typed it.</item>
    /// <item><b>Whole-value write.</b> <c>ValuePattern.SetValue</c> with the
    ///   spliced text. Works in Win32 edits, WinForms and WPF text boxes, needs
    ///   no foreground window, and is the only option in Electron builds that
    ///   expose a value but refuse a selection. It loses the app's undo stack
    ///   and moves the caret to the end, which is why it is second.</item>
    /// <item><b>Backspace and retype.</b> Only when the burst is the tail of
    ///   the field and the caret is sitting at the end of it. Anything less
    ///   exact and a mistimed backspace eats the user's own text, so this
    ///   refuses rather than guesses.</item>
    /// </list>
    ///
    /// <paramref name="before"/> is the field value the plan was made from;
    /// nothing is written when the field no longer holds it — the guard is
    /// re-checked immediately before each destructive step, because the
    /// selection round trip takes real time. That comparison is of the field's
    /// whole text, which is necessary and not sufficient: the user can move the
    /// selection without changing a character of it, so the keystroke path also
    /// re-reads the <i>selection</i> immediately before typing.
    ///
    /// UNVERIFIED: this ladder has never been run against a real provider. The
    /// ordering is the reasoned counterpart of the macOS one, not a measured one.
    /// </summary>
    private (string? Strategy, string Detail) Write(RewritePlan plan, UiaField field, string before)
    {
        List<string> notes = new();

        if ((field.ReadValue(ReadLimit) ?? string.Empty) != before)
        {
            return (null, "field changed before the write");
        }

        // --- 1. select and type -------------------------------------------
        bool selected = field.SelectSpan(plan.Span, plan.PreviousText, before.Length);
        notes.Add(selected ? "span selected" : "span not selectable");

        if (selected)
        {
            // Selecting took a round trip. Make sure the field is still the one
            // the plan was computed from before typing over it.
            if ((field.ReadValue(ReadLimit) ?? string.Empty) != before)
            {
                return (null, $"field changed while selecting ({string.Join(", ", notes)})");
            }

            if (!field.IsForeground())
            {
                notes.Add("not foreground, keystrokes skipped");
            }
            else if (TextDiff.ContainsNewline(plan.NewText))
            {
                // Belt and braces: the planner already refuses this, because a
                // synthesized Return in a chat composer sends the message.
                notes.Add("replacement contains a newline, keystrokes skipped");
            }
            else if (!field.SelectionMatches(plan.Span, plan.PreviousText))
            {
                // The whole-text comparison above cannot see this. Home, End,
                // an arrow key or a click elsewhere in the same field moves the
                // selection while leaving every character where it was, and the
                // keystrokes would then land at the caret instead of over the
                // span. Verified last, immediately before SendInput, because
                // everything above it — selecting, re-reading, the foreground
                // check — takes round trips the user can type into.
                notes.Add("selection moved after it was made, keystrokes skipped");
            }
            else if (Keyboard.Type(plan.NewText))
            {
                if (field.Verify(plan.SplicedFullText, 0.6, ReadLimit))
                {
                    return ("keystrokes", string.Join(", ", notes));
                }

                notes.Add("keystrokes not reflected");
                if ((field.ReadValue(ReadLimit) ?? string.Empty) != before)
                {
                    // Something landed but not what was planned: stop rather
                    // than write again on top of a field we no longer understand.
                    return (null, $"typing changed the field to something else; left alone ({string.Join(", ", notes)})");
                }
            }
            else
            {
                notes.Add("SendInput refused (elevated window?)");
            }
        }

        // --- 2. whole-value write ------------------------------------------
        if ((field.ReadValue(ReadLimit) ?? string.Empty) != before)
        {
            return (null, $"field changed ({string.Join(", ", notes)})");
        }

        if (field.HasWritableValuePattern())
        {
            if (field.SetWholeValue(plan.SplicedFullText)
                && field.Verify(plan.SplicedFullText, 0.3, ReadLimit))
            {
                return ("value", string.Join(", ", notes));
            }

            notes.Add("value write not reflected");
            if ((field.ReadValue(ReadLimit) ?? string.Empty) != before)
            {
                return (null, $"the value write changed the field to something else; left alone ({string.Join(", ", notes)})");
            }
        }
        else
        {
            notes.Add("no writable ValuePattern");
        }

        // --- 3. backspace and retype ---------------------------------------
        // Deliberately the narrowest path in the app. It is the only one that
        // destroys text without first proving the app agrees where that text
        // is, so it runs only when the burst is unambiguously the tail of the
        // field and the caret is already sitting behind it.
        bool atEnd = plan.Span.End == before.Length;
        int? caret = field.CaretEnd();
        if (atEnd && caret == before.Length && field.IsForeground()
            && !TextDiff.ContainsNewline(plan.NewText)
            && plan.PreviousText.Length > 0)
        {
            if (Keyboard.Press(VIRTUAL_KEY.VK_BACK, plan.PreviousText.Length)
                && Keyboard.Type(plan.NewText)
                && field.Verify(plan.SplicedFullText, 0.6, ReadLimit))
            {
                return ("backspace", string.Join(", ", notes));
            }

            notes.Add("backspace rewrite not reflected");
        }
        else
        {
            notes.Add("backspace path not applicable");
        }

        return (null, string.Join(", ", notes));
    }

    private void PerformUndo()
    {
        if (_field is not UiaField field || _detector is not BurstDetector detector)
        {
            Report(new Event.Skipped("Nothing to undo: no text field focused."));
            return;
        }

        string current = field.ReadValue(ReadLimit) ?? string.Empty;
        UndoLedger.Entry? entry = _undo.Take(field.Key, current);
        if (entry is null || entry.FieldTextBefore is not string restored)
        {
            Report(new Event.Skipped($"Nothing to undo in {field.AppName}."));
            PublishUndoAvailability(current, force: true);
            return;
        }

        RewritePlan plan = new(
            new TextSpan(entry.Span.Location, entry.CorrectedText.Length),
            entry.CorrectedText,
            entry.PreviousText,
            restored);

        (string? strategy, string detail) = Write(plan, field, before: current);
        if (strategy is not null)
        {
            detector.MarkStable(restored);
            _watcher.NoteValue(restored, field);
            Report(new Event.Undone(field.AppName));
        }
        else
        {
            Report(new Event.Failed($"Undo failed in {field.AppName}: {detail}"));
        }

        PublishUndoAvailability(field.ReadValue(ReadLimit) ?? string.Empty, force: true);
    }

    private void PublishUndoAvailability(string currentText, bool force = false)
    {
        bool available = _field is UiaField field && _undo.CanUndo(field.Key, currentText);
        if (!force && available == _undoWasAvailable) return;
        _undoWasAvailable = available;
        Report(new Event.UndoAvailable(available));
    }

    private void Report(Event @event)
    {
        if (@event is Event.Failed failed) Log.Warn(failed.Why);
        if (@event is Event.Fixed fixedEvent) LastFix = fixedEvent.Fix;
        _ui.Post(_ => OnEvent?.Invoke(@event), null);
    }
}
