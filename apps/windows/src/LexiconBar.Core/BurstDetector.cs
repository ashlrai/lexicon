namespace LexiconBar;

/// <summary>
/// A span of text that arrived in the focused field in one "burst": what a
/// dictation tool inserted, as opposed to what the user typed key by key.
/// </summary>
/// <param name="Span">Where the burst sits inside <paramref name="FullText"/>, in UTF-16 units.</param>
/// <param name="Text">The burst itself.</param>
/// <param name="FullText">
/// The whole field value the burst was cut from, so the engine can refuse to
/// rewrite when the field moved on before the API answered.
/// </param>
public sealed record Burst(TextSpan Span, string Text, string FullText);

/// <summary>What <see cref="BurstDetector.Settle"/> decided.</summary>
public abstract record SettleOutcome
{
    private SettleOutcome() { }

    /// <summary>Nothing pending, or not quiet long enough yet.</summary>
    public sealed record Waiting : SettleOutcome
    {
        public static readonly Waiting Instance = new();
    }

    /// <summary>
    /// Dictation is still streaming in: word-sized insertions have been
    /// arriving and the field has not been quiet long enough to call the
    /// phrase finished. Nothing has been decided and the baseline has not
    /// moved — ask again shortly.
    /// </summary>
    public sealed record Coalescing : SettleOutcome
    {
        public static readonly Coalescing Instance = new();
    }

    /// <summary>Pending changes were examined and dismissed; the baseline advanced.</summary>
    public sealed record Skipped(string Reason) : SettleOutcome;

    /// <summary>A burst to send to the API.</summary>
    public sealed record Fired(Burst Burst) : SettleOutcome;
}

/// <summary>
/// Turns a stream of field-value snapshots into bursts. Pure and clock-free:
/// the caller feeds <see cref="Record"/> on every value change and asks
/// <see cref="Settle"/> once it has been quiet for a while.
///
/// One detector per focused element. <see cref="LastStable"/> is the text the
/// field held after the previous decision (fired, skipped or the engine's own
/// rewrite), so the engine's rewrite never re-triggers and typed text that was
/// skipped once is not counted again.
///
/// A burst fires when the field has been quiet for <c>SettleMs</c> and the text
/// inserted since <see cref="LastStable"/>:
/// <list type="bullet">
/// <item>contains at least <c>MinWords</c> words, or arrived in at most
///   <c>FewEvents</c> change events with at least <c>FewEventsMinChars</c> units; and</item>
/// <item>contains at least one change event that inserted <c>MinChunk</c> units
///   at once (dictation lands as words or phrases; typing lands one unit at a
///   time, so key-by-key typing never fires); and</item>
/// <item>is not multi-paragraph (a newline followed by more text) and the field
///   is not longer than <c>MaxFieldLength</c>.</item>
/// </list>
///
/// A direct port of <c>BurstDetector.swift</c>. The four rules that look
/// over-engineered — chunk size rather than rate, coalescing a streamed run,
/// anchoring the window to the caret, and refusing a stale snapshot — each
/// came from a real text-corruption bug on macOS. Do not simplify them.
/// </summary>
public sealed class BurstDetector
{
    /// <param name="FewEvents">Bursts that arrived in this many events or fewer fire at <c>FewEventsMinChars</c> units even if short on words.</param>
    /// <param name="MinChunk">At least one event must insert this many units at once.</param>
    /// <param name="RunQuietMs">
    /// Quiet needed to call a *streamed* run finished, as opposed to a single
    /// insertion. Speech pauses are routinely longer than <c>SettleMs</c>, so a
    /// streamed phrase is only finished after a silence longer than a pause
    /// between words.
    /// </param>
    /// <param name="MaxRunMs">
    /// Hard cap on how long one run may go on coalescing, so continuous
    /// dictation is still corrected periodically instead of never.
    /// </param>
    public sealed record Config(
        int SettleMs = 700,
        int MinWords = 3,
        int FewEvents = 3,
        int FewEventsMinChars = 12,
        int MinChunk = 4,
        int MaxFieldLength = 20_000,
        int RunQuietMs = 1500,
        int MaxRunMs = 12_000)
    {
        public static readonly Config Default = new();
    }

    public Config Settings { get; set; }

    /// <summary>The text the field held after the last decision.</summary>
    public string LastStable { get; private set; }

    /// <summary>The most recent snapshot fed to <see cref="Record"/>.</summary>
    public string Latest { get; private set; }

    private double? _lastChangeAt;

    /// <summary>
    /// When the first change since <see cref="LastStable"/> arrived, so a
    /// coalescing run can be capped by age as well as by silence.
    /// </summary>
    private double? _runStartedAt;

    private int _eventCount;
    private int _maxChunk;

    public BurstDetector(string initialText, Config? config = null)
    {
        Settings = config ?? Config.Default;
        LastStable = initialText;
        Latest = initialText;
    }

    public bool HasPendingChanges => _lastChangeAt is not null;

    /// <summary>Feed the field's current value. Identical values are ignored.</summary>
    public void Record(string text, double atSeconds)
    {
        if (text == Latest) return;
        TextDiff.Delta step = TextDiff.ComputeDelta(Latest, text);
        Latest = text;
        if (_lastChangeAt is null && _runStartedAt is null)
        {
            _eventCount = 0;
            _maxChunk = 0;
            _runStartedAt = atSeconds;
        }

        _eventCount++;
        _maxChunk = Math.Max(_maxChunk, step.Inserted);
        _lastChangeAt = atSeconds;
        if (text == LastStable)
        {
            // Back where we started (undo, or a rewrite landing): nothing pending.
            ClearPending();
        }
    }

    /// <summary>The engine rewrote the field itself: treat <paramref name="text"/> as settled.</summary>
    public void MarkStable(string text)
    {
        LastStable = text;
        Latest = text;
        ClearPending();
    }

    /// <summary>
    /// Ask whether the pending changes form a burst. Call after <c>SettleMs</c>
    /// of quiet; it is safe to call more often.
    /// </summary>
    /// <param name="caretEnd">
    /// Where the insertion point sits now (UTF-16 offset into the field). It
    /// decides *which* of several textually identical windows was the one that
    /// arrived; without it an ambiguous insertion is skipped rather than
    /// guessed at, because rewriting the wrong window corrupts the text around it.
    /// </param>
    public SettleOutcome Settle(double atSeconds, int? caretEnd = null)
    {
        if (_lastChangeAt is not double lastChangeAt) return SettleOutcome.Waiting.Instance;
        double quietMs = (atSeconds - lastChangeAt) * 1000;
        if (quietMs < Settings.SettleMs - 0.5) return SettleOutcome.Waiting.Instance;

        string text = Latest;
        TextDiff.Delta delta = TextDiff.ComputeDelta(LastStable, text, caretEnd);
        int events = _eventCount;
        int chunk = _maxChunk;
        double runAgeMs = _runStartedAt is double started ? (atSeconds - started) * 1000 : 0;
        Verdict verdict = Evaluate(text, delta, events, chunk);

        // Streamed dictation (Windows Voice Access, Wispr Flow, an app's own
        // microphone button) does not arrive as one insertion. It arrives a
        // word at a time, and the gaps between spoken words are routinely
        // longer than SettleMs — so deciding at SettleMs chops the phrase into
        // single words, each of which is "too short" and is dropped. The whole
        // sentence then goes uncorrected, which looks exactly like the feature
        // not working.
        //
        // So: once a run has produced at least one word-sized insertion, keep
        // it pending until the field has been quiet for RunQuietMs — longer
        // than a pause between words, shorter than the end of a sentence —
        // rather than deciding at the first gap. LastStable does not move, so
        // the words accumulate into one burst and are corrected together.
        //
        // Two things keep this from swallowing ordinary typing and pastes:
        // key-by-key typing never produces a MinChunk-sized insertion, so it is
        // never a run and is still refused with "typed, not dictated"; and a
        // single insertion that already reads as a burst is a paste with
        // nothing to wait for, so it fires at SettleMs as before.
        //
        // Only a verdict that more speech could actually change is worth
        // waiting on. Everything else — multi-paragraph, field too long,
        // key-by-key typing, an insertion point we cannot locate — is refused
        // now, because silence will not make it true.
        bool canGrow = verdict switch
        {
            Verdict.Fired => events > 1,
            Verdict.TooShort => true,
            _ => false,
        };
        if (canGrow && quietMs < Settings.RunQuietMs && runAgeMs < Settings.MaxRunMs)
        {
            return SettleOutcome.Coalescing.Instance;
        }

        // Whatever we decide, this is the new baseline.
        LastStable = text;
        ClearPending();
        return verdict switch
        {
            Verdict.Fired fired => new SettleOutcome.Fired(fired.Burst),
            Verdict.TooShort tooShort => new SettleOutcome.Skipped(tooShort.Why),
            Verdict.Refused refused => new SettleOutcome.Skipped(refused.Why),
            _ => SettleOutcome.Waiting.Instance,
        };
    }

    /// <summary>What <see cref="Settle"/> decided, before it decides whether to act on it.</summary>
    private abstract record Verdict
    {
        private Verdict() { }

        public sealed record Fired(Burst Burst) : Verdict;

        /// <summary>Dictation-shaped, but not enough of it yet. More speech changes this.</summary>
        public sealed record TooShort(string Why) : Verdict;

        /// <summary>No amount of waiting changes this.</summary>
        public sealed record Refused(string Why) : Verdict;
    }

    /// <summary>
    /// The burst rules, with no side effects, so <see cref="Settle"/> can look
    /// at the answer and still leave the run pending.
    /// </summary>
    private Verdict Evaluate(string text, TextDiff.Delta delta, int events, int chunk)
    {
        if (delta.Inserted <= 0) return new Verdict.Refused("nothing inserted");
        if (text.Length > Settings.MaxFieldLength)
        {
            return new Verdict.Refused($"field longer than {Settings.MaxFieldLength}");
        }

        if (TextDiff.Substring(text, delta.InsertedSpan) is not string inserted)
        {
            return new Verdict.Refused("range out of bounds");
        }

        // A trailing newline (dictation ending with "new line", or Return)
        // stays out of the burst so the rewrite never has to re-insert one.
        TextSpan span = delta.InsertedSpan;
        while (inserted.Length > 0 && (inserted[^1] == '\n' || inserted[^1] == '\r'))
        {
            inserted = inserted[..^1];
            span = span with { Length = span.Length - 1 };
        }

        if (span.Length <= 0) return new Verdict.Refused("nothing inserted");
        if (chunk < Settings.MinChunk) return new Verdict.Refused("typed, not dictated");

        int words = TextDiff.WordCount(inserted);
        bool enough = words >= Settings.MinWords
                      || (events <= Settings.FewEvents && inserted.Length >= Settings.FewEventsMinChars);
        if (!enough) return new Verdict.TooShort($"too short ({words} words, {inserted.Length} units)");
        if (IsMultiParagraph(inserted)) return new Verdict.Refused("multi-paragraph");

        // Last, because it is the only check whose answer is "this really does
        // look like a burst, but we cannot say where it went". Rewriting a
        // window we only guessed at splices the correction into the middle of
        // the user's own words, so there is nothing to do but leave it alone.
        if (delta.IsAmbiguous)
        {
            return new Verdict.Refused(
                $"insertion point is ambiguous ({delta.SlideLeft} left, {delta.SlideRight} right)");
        }

        return new Verdict.Fired(new Burst(span, inserted, text));
    }

    /// <summary>A newline followed by more (non-whitespace) text. A trailing newline is fine.</summary>
    public static bool IsMultiParagraph(string text)
    {
        for (int i = 0; i < text.Length; i++)
        {
            if (!TextDiff.IsNewline(text[i])) continue;
            for (int j = i + 1; j < text.Length; j++)
            {
                if (!char.IsWhiteSpace(text[j])) return true;
            }
            return false;
        }
        return false;
    }

    private void ClearPending()
    {
        _lastChangeAt = null;
        _runStartedAt = null;
        _eventCount = 0;
        _maxChunk = 0;
    }
}
