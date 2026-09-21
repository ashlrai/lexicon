using System.Drawing;
using LexiconBar.Interop;

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

    /// <summary>
    /// This class's own copy of "may we read, and where", kept in step with
    /// <see cref="_config"/>. Separate from the watcher's on purpose: the two
    /// are pushed separately, so for the width of one settings change they can
    /// disagree, and refusing against both means the newer of the two wins.
    /// </summary>
    private readonly ReadPolicy _policy = new();

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
            // The change records are for the watcher, which holds a field and a
            // poll to let go of. Nothing here does, so they are dropped.
            _policy.SetEnabled(config.Enabled);
            _policy.SetExclusions(config.Exclusions);
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

            // Off means the watcher reads nothing at all, not that it reads
            // everything and this class declines to act on it. Last, and on
            // this thread rather than posted, so that by the time it runs the
            // config above is the new one and the switch cannot be overtaken by
            // work queued behind it. Turning it back on re-resolves focus,
            // which is what rebuilds the detector.
            _watcher.SetReading(config.Enabled);
        });
    }

    /// <summary>Ctrl+Alt+Z, the menu and the bubble's Undo all land here.</summary>
    internal void UndoLast() => _thread.Post(PerformUndo);

    private int ReadLimit => _config.Detector.MaxFieldLength + 1;

    /// <summary>
    /// How long a write is given to show up in the field before the engine
    /// decides what happened. The same number for the write working and for the
    /// write half working, because it is the same wait: the app consumes
    /// synthesized input on its own message loop, and nothing about that loop
    /// speeds up because <c>SendInput</c> returned a short count.
    /// </summary>
    private const double SettleSeconds = 0.6;

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
    /// The same check runs again in <see cref="Settle"/>, before the caret read
    /// that would pull text across, and once more in <see cref="Handle"/>,
    /// immediately before anything is sent to the local API.
    /// </summary>
    private BurstDetector? MakeDetector(UiaField field, string value) =>
        Refusal(field) is string why ? Refuse(field, why) : new BurstDetector(value, _config.Detector);

    /// <summary>
    /// Why this field is one we will not act on, or null. The same call the
    /// watcher gates its reads with, against this class's copy of the config.
    /// </summary>
    private string? Refusal(UiaField field) => _policy.Refuse(field.ProcessName, field.Hints);

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

        // The gate, before the read, because the next line is a read. CaretEnd
        // measures the document in front of the caret, which means pulling that
        // text across the process boundary; a refusal that arrived while this
        // timer was armed has to be honoured here and not two calls later in
        // Handle. Today the watcher drops a newly refused field before this
        // timer can fire, so this is not known to be reachable — but the
        // ordering is what SECURITY.md promises, and a promise that holds only
        // because of the queue discipline in another class is not one worth
        // making.
        if (Refusal(field) is string refused)
        {
            Log.Info($"skip in {field.ProcessName}: {refused}");
            _detector = null;
            return;
        }

        // Where the caret is now tells the detector which of several textually
        // identical windows actually arrived. Without it, dictation in front of
        // text that starts the same way is located several units late.
        int? caretEnd = field.CaretEnd(ReadLimit);

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
        // The last of the four checks, and the one that matters most: this is
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

        WriteOutcome outcome = Write(plan, field, before: current);
        if (outcome.Strategy is not string strategy)
        {
            ReportWriteFailure(field, outcome);
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
    ///   refuses rather than guesses. The backspaces and the replacement go in
    ///   one <c>SendInput</c> call, because in two the deletion can succeed and
    ///   the retype fail.</item>
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
    /// Only strategy 1 and strategy 3 can half-finish, and only through
    /// <c>SendInput</c>. Both are now a single call each, capped at
    /// <c>Keyboard.MaxKeyEvents</c>. A write that does not visibly work goes to
    /// <see cref="KeystrokeSettle"/>, which watches the field over the same
    /// window the success path waits out and says what it settled on: all of it
    /// after all, part of it, or none of it. Part of it is turned into a
    /// <see cref="PartialWrite"/>, repaired by the whole-value write where that
    /// is available and recorded in the undo ledger where it is not. None of it,
    /// with keystrokes the system accepted, stops the ladder rather than write
    /// a value the queued keystrokes would land on top of. What must never
    /// happen again is the old behaviour: half a replacement in the field, the
    /// user's original span gone, an undo that was never recorded and a message
    /// saying the write failed.
    ///
    /// UNVERIFIED: this ladder has never been run against a real provider. The
    /// ordering is the reasoned counterpart of the macOS one, not a measured one.
    /// </summary>
    private WriteOutcome Write(RewritePlan plan, UiaField field, string before)
    {
        List<string> notes = new();

        // Set as soon as our own keystrokes are known to have half-landed. From
        // that moment the field no longer holds `before`, and every guard below
        // that compares against `before` has to compare against this instead:
        // refusing to touch a field we ourselves left half-written is the one
        // case where doing nothing is the worse answer.
        PartialWrite? halfWritten = null;

        if ((field.ReadValue(ReadLimit) ?? string.Empty) != before)
        {
            return new WriteOutcome(null, "field changed before the write");
        }

        // --- 1. select and type -------------------------------------------
        bool fits = Keyboard.Fits(plan.NewText.Length);
        bool selected = fits && field.SelectSpan(plan.Span, plan.PreviousText, before.Length);
        notes.Add(fits
            ? selected ? "span selected" : "span not selectable"
            : $"replacement is {plan.NewText.Length} characters, too long for one uninterruptible write");

        if (selected)
        {
            // Selecting took a round trip. Make sure the field is still the one
            // the plan was computed from before typing over it.
            if ((field.ReadValue(ReadLimit) ?? string.Empty) != before)
            {
                return new WriteOutcome(null, $"field changed while selecting ({string.Join(", ", notes)})");
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
            else if (!field.SelectionMatches(plan.Span, plan.PreviousText, ReadLimit))
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
            else
            {
                int typed = Keyboard.Type(plan.NewText);
                if (typed == plan.NewText.Length && field.Verify(plan.SplicedFullText, SettleSeconds, ReadLimit))
                {
                    return new WriteOutcome("keystrokes", string.Join(", ", notes));
                }

                notes.Add(typed == plan.NewText.Length
                    ? "keystrokes not reflected"
                    : typed == 0
                        ? "SendInput refused (elevated window?)"
                        : $"SendInput took {typed} of {plan.NewText.Length} characters");

                // Whatever the count said, the field is the evidence, and it is
                // read over a window rather than once: SendInput queues, and the
                // app consumes on its own message loop. See KeystrokeSettle.
                SettledWrite settled = KeystrokeSettle.Resolve(
                    before,
                    plan.SplicedFullText,
                    plan.NewText.Length,
                    typed,
                    landed => landed >= plan.NewText.Length
                        ? FullWrite(plan)
                        : PartialWrite.OverSelection(plan, before, landed),
                    field.Polling(SettleSeconds, ReadLimit));

                switch (settled)
                {
                    case SettledWrite.Complete:
                        notes.Add("late, but all of it landed");
                        return new WriteOutcome("keystrokes", string.Join(", ", notes));

                    case SettledWrite.Half half:
                        // Carry it down the ladder: the value write below is the
                        // repair, and if there is no value write the caller still
                        // gets an undo entry that puts the user's own text back.
                        halfWritten = half.Partial;
                        notes.Add(
                            $"{half.Partial.WrittenText.Length} of {plan.NewText.Length} characters landed; repairing");
                        break;

                    case SettledWrite.Untouched when typed == 0:
                        // Nothing was accepted, so nothing is queued and nothing
                        // can arrive later. The value write below is safe and is
                        // the whole point of the ladder.
                        notes.Add("the field is unchanged");
                        break;

                    case SettledWrite.Untouched untouched:
                        // The system took the keystrokes and the field has not
                        // shown them. They may still be queued for the app, in
                        // which case writing the value now would put them on top
                        // of the write and leave text nothing has a record of. So
                        // this stops, and hands up the state the field will hold
                        // if they do arrive, so that it is undoable when it does.
                        return new WriteOutcome(
                            null,
                            $"the keystrokes were accepted but have not appeared ({string.Join(", ", notes)})",
                            Pending: untouched.Pending);

                    case SettledWrite.Unexplained:
                        return new WriteOutcome(
                            null,
                            "typing landed somewhere this cannot account for; left alone "
                                + $"({string.Join(", ", notes)})");
                }
            }
        }

        // --- 2. whole-value write ------------------------------------------
        // Also the repair for a keystroke write that half-landed: SetValue
        // replaces the whole value, so it does not care what state the field is
        // in, and the "is the field still what the plan was made from?" guard
        // would otherwise refuse the one case that most needs repairing.
        string expected = halfWritten?.FieldText ?? before;
        if ((field.ReadValue(ReadLimit) ?? string.Empty) != expected)
        {
            return new WriteOutcome(null, $"field changed ({string.Join(", ", notes)})", halfWritten);
        }

        if (field.HasWritableValuePattern())
        {
            if (field.SetWholeValue(plan.SplicedFullText)
                && field.Verify(plan.SplicedFullText, 0.3, ReadLimit))
            {
                return new WriteOutcome("value", string.Join(", ", notes));
            }

            notes.Add("value write not reflected");
            if ((field.ReadValue(ReadLimit) ?? string.Empty) != expected)
            {
                return new WriteOutcome(
                    null,
                    $"the value write changed the field to something else; left alone ({string.Join(", ", notes)})",
                    halfWritten);
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
        if (halfWritten is not null)
        {
            // Every offset this path relies on was measured against `before`,
            // and the field no longer holds `before`. Stop here and hand the
            // recovery up rather than backspace over a field we half-wrote.
            notes.Add("backspace path skipped: the field already holds part of the correction");
            return new WriteOutcome(null, string.Join(", ", notes), halfWritten);
        }

        int events = plan.PreviousText.Length + plan.NewText.Length;
        bool atEnd = plan.Span.End == before.Length;
        int? caret = field.CaretEnd(ReadLimit);
        if (atEnd && caret == before.Length && Keyboard.Fits(events) && field.IsForeground()
            && !TextDiff.ContainsNewline(plan.NewText)
            && plan.PreviousText.Length > 0)
        {
            // Backspaces and replacement in one call. Two calls left a gap in
            // which the deletion had happened and the retype had not, with
            // nothing recorded that could put the deleted text back.
            int delivered = Keyboard.ReplaceTail(plan.PreviousText.Length, plan.NewText);
            if (delivered == events && field.Verify(plan.SplicedFullText, SettleSeconds, ReadLimit))
            {
                return new WriteOutcome("backspace", string.Join(", ", notes));
            }

            notes.Add(delivered == events
                ? "backspace rewrite not reflected"
                : $"backspace rewrite delivered {delivered} of {events} key events");

            // The same settle as the keystroke path above, and the branch that
            // most needs it: the backspaces go first, so every event that does
            // land destroys a character before any of them puts one back.
            SettledWrite settled = KeystrokeSettle.Resolve(
                before,
                plan.SplicedFullText,
                events,
                delivered,
                landed => landed >= events
                    ? FullWrite(plan)
                    : PartialWrite.OverTail(plan, before, landed),
                field.Polling(SettleSeconds, ReadLimit));

            switch (settled)
            {
                case SettledWrite.Complete:
                    notes.Add("late, but all of it landed");
                    return new WriteOutcome("backspace", string.Join(", ", notes));

                case SettledWrite.Half half:
                    // There is no repair left below this, so all the caller can
                    // do is record it. That is the difference between a lost
                    // span and one keystroke away from being back.
                    return new WriteOutcome(null, string.Join(", ", notes), half.Partial);

                case SettledWrite.Untouched untouched when untouched.Pending is not null:
                    return new WriteOutcome(null, string.Join(", ", notes), Pending: untouched.Pending);
            }
        }
        else if (!Keyboard.Fits(events))
        {
            notes.Add($"backspace path would need {events} key events, too many for one uninterruptible write");
        }
        else
        {
            notes.Add("backspace path not applicable");
        }

        return new WriteOutcome(null, string.Join(", ", notes));
    }

    /// <summary>
    /// The whole correction, in the shape the settle and the ledger both take.
    ///
    /// <see cref="PartialWrite.OverSelection"/> and
    /// <see cref="PartialWrite.OverTail"/> both answer null for a full count,
    /// because a full count is the write simply working and there is nothing
    /// partial to describe. The settle still needs that state described: a write
    /// the system accepted in full can arrive after the engine has stopped
    /// waiting for it, and then it is the whole correction sitting in the field
    /// with no ledger entry behind it. Undoing this is the same splice
    /// <see cref="Apply"/> records when the write works first time.
    /// </summary>
    private static PartialWrite FullWrite(RewritePlan plan) =>
        new(plan.SplicedFullText, plan.Span, plan.NewText, plan.PreviousText);

    /// <summary>What a write managed, and what it left behind if it did not manage all of it.</summary>
    /// <param name="Strategy">Non-null exactly when the field now holds <c>plan.SplicedFullText</c>.</param>
    /// <param name="Partial">
    /// Set when synthesized keystrokes landed only in part, in which case the
    /// field holds <see cref="PartialWrite.FieldText"/> and the caller must
    /// record the matching ledger entry before it tells the user anything.
    /// </param>
    /// <param name="Pending">
    /// Set when the system accepted keystrokes that never appeared in the field.
    /// Nothing was written and the field still holds the user's own text, so
    /// there is nothing to repair; this is what it will hold if they turn up
    /// after the engine stopped waiting, recorded so that it is reversible if
    /// they do. Never set together with <paramref name="Partial"/>.
    /// </param>
    private sealed record WriteOutcome(
        string? Strategy,
        string Detail,
        PartialWrite? Partial = null,
        PartialWrite? Pending = null);

    /// <summary>
    /// Makes a half-landed keystroke write undoable, and says whether it could.
    ///
    /// The field is re-read first. <see cref="PartialWrite"/> is arithmetic
    /// about what must have happened, not an observation, and an entry that
    /// does not match the field would offer an undo that splices at the wrong
    /// offset — which is the same class of damage this whole change exists to
    /// stop. When they disagree nothing is recorded and the caller says so.
    /// </summary>
    private bool RecordPartial(PartialWrite? halfWritten, UiaField field)
    {
        if (halfWritten is null) return false;
        if ((field.ReadValue(ReadLimit) ?? string.Empty) != halfWritten.FieldText) return false;

        _undo.Record(halfWritten.Entry(field.Key));
        _detector?.MarkStable(halfWritten.FieldText);
        _watcher.NoteValue(halfWritten.FieldText, field);
        PublishUndoAvailability(halfWritten.FieldText, force: true);
        return true;
    }

    /// <summary>
    /// Tells the user what actually happened. "Could not write" is only true
    /// when nothing was written; a half-written field gets a sentence that says
    /// so and points at the undo that was just recorded for it.
    /// </summary>
    private void ReportWriteFailure(UiaField field, WriteOutcome outcome)
    {
        if (outcome.Partial is null && outcome.Pending is PartialWrite pending)
        {
            // Nothing is in the field, so nothing is recorded about the field as
            // it is now. The entry describes the state the queued keystrokes
            // would produce, and the ledger only ever offers an undo to a field
            // whose text matches its entry exactly, so it sits inert unless they
            // actually arrive. If they do, the next value change publishes the
            // offer and the user's own words are one hotkey away.
            _undo.Record(pending.Entry(field.Key));
            PublishUndoAvailability(field.ReadValue(ReadLimit) ?? string.Empty, force: true);
            Report(new Event.Failed(
                $"Nothing was written into {field.AppName} and your text is as you left it: {outcome.Detail}. "
                    + "If the correction appears late, Undo (Ctrl+Alt+Z) takes it back out."));
            return;
        }

        if (outcome.Partial is null)
        {
            Report(new Event.Failed($"Could not write into {field.AppName}: {outcome.Detail}"));
            return;
        }

        Report(new Event.Failed(RecordPartial(outcome.Partial, field)
            ? $"Only part of the correction went into {field.AppName}: {outcome.Detail}. "
                + "Undo (Ctrl+Alt+Z) puts your text back."
            : $"Part of the correction went into {field.AppName} and the field then changed, "
                + $"so it cannot be put back from here: {outcome.Detail}"));
    }

    /// <summary>
    /// Ctrl+Alt+Z. Everything decided before the field is touched lives in
    /// <see cref="UndoPlanner"/>, in the portable core, so that the one
    /// ordering that matters here can be tested: the gate is consulted before
    /// the read, and the read before the write. This used to go straight to
    /// ReadValue, which made this the one path where excluding an app while it
    /// still held focus stopped neither the read nor the write, while every
    /// other path in this class refused it. macOS had the same hole in the
    /// same method. What is left below is the writing.
    /// </summary>
    private void PerformUndo()
    {
        if (_field is not UiaField field)
        {
            Report(new Event.Skipped("Nothing to undo: no text field focused."));
            return;
        }

        UndoDecision decision = UndoPlanner.Plan(
            _policy, field, _undo, watching: _detector is not null, ReadLimit);

        switch (decision)
        {
            case UndoDecision.Off:
                Report(new Event.Skipped("Fix everywhere is off."));
                return;

            case UndoDecision.Refused refused:
                Log.Info($"skip undo in {field.ProcessName}: {refused.Reason}");

                // The planner has already dropped the ledger entry, which held
                // that field's text.
                Report(new Event.Skipped($"Not undoing in {field.AppName}: {refused.Reason}"));
                PublishUndoAvailability(string.Empty, force: true);
                return;

            case UndoDecision.NotWatching:
                Report(new Event.Skipped("Nothing to undo: no text field focused."));
                return;

            case UndoDecision.Nothing nothing:
                Report(new Event.Skipped($"Nothing to undo in {field.AppName}."));
                PublishUndoAvailability(nothing.CurrentText, force: true);
                return;

            case UndoDecision.Go go:
                WriteUndo(go.Plan, go.CurrentText, field);
                return;
        }
    }

    /// <summary>The keystroke half of an undo the planner has approved.</summary>
    private void WriteUndo(RewritePlan plan, string current, UiaField field)
    {
        if (_detector is not BurstDetector detector) return;
        string restored = plan.SplicedFullText;

        WriteOutcome outcome = Write(plan, field, before: current);
        if (outcome.Strategy is not null)
        {
            // Consumed only now. The entry used to be taken before the write,
            // so an undo that did nothing threw it away and left the user with
            // a correction they could no longer reverse.
            _undo.Clear();
            detector.MarkStable(restored);
            _watcher.NoteValue(restored, field);
            Report(new Event.Undone(field.AppName));
        }
        else if (RecordPartial(outcome.Partial, field))
        {
            // The undo itself half-landed. The ledger now describes that state
            // instead of the one before it, so undoing again returns the field
            // to the corrected text rather than leaving it somewhere nothing
            // has a record of.
            Report(new Event.Failed(
                $"Undo only partly landed in {field.AppName}: {outcome.Detail}. "
                    + "Undo again to put it back the way it was."));
        }
        else
        {
            // The original entry is untouched, so the offer stands and the user
            // can try again.
            Report(new Event.Failed($"Undo failed in {field.AppName}: {outcome.Detail}"));
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
