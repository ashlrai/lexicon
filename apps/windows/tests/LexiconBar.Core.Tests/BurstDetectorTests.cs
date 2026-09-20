using Xunit;

namespace LexiconBar.Tests;

/// <summary>
/// A port of <c>Tests/LexiconBarKitTests/BurstDetectorTests.swift</c>, case for
/// case. If a case here diverges from the Swift one, one of the two ports has
/// drifted and the two apps no longer behave the same way.
/// </summary>
public class BurstDetectorTests
{
    private const double Settle = 0.7;

    /// <summary>Silence that ends a streamed run (<c>Config.RunQuietMs</c>).</summary>
    private const double RunQuiet = 1.5;

    /// <summary>Types <paramref name="text"/> one character at a time, <paramref name="gap"/> seconds apart.</summary>
    private static double Type(string text, BurstDetector d, string baseText, double from, double gap = 0.08)
    {
        double now = from;
        string current = baseText;
        foreach (char ch in text)
        {
            current += ch;
            d.Record(current, now);
            now += gap;
        }
        return now;
    }

    private static Burst ExpectBurst(SettleOutcome outcome)
    {
        SettleOutcome.Fired fired = Assert.IsType<SettleOutcome.Fired>(outcome);
        return fired.Burst;
    }

    private static void ExpectSkipped(string reason, SettleOutcome outcome) =>
        Assert.Equal(new SettleOutcome.Skipped(reason), outcome);

    [Fact]
    public void CharAtATimeTypingNeverFires()
    {
        BurstDetector d = new(string.Empty);
        double end = Type("ping ashler about the cooper netties rollout", d, string.Empty, 0);
        ExpectSkipped("typed, not dictated", d.Settle(end + Settle));
        Assert.Equal("ping ashler about the cooper netties rollout", d.LastStable);
        // And a later poll finds nothing pending.
        Assert.Equal(SettleOutcome.Waiting.Instance, d.Settle(end + 5));
    }

    [Fact]
    public void FiveWordInsertionFiresAfterSettle()
    {
        BurstDetector d = new("Hi. ");
        d.Record("Hi. ping ashler about the rollout", 1.0);
        Assert.Equal(SettleOutcome.Waiting.Instance, d.Settle(1.3));
        Burst burst = ExpectBurst(d.Settle(1.0 + Settle));
        Assert.Equal("ping ashler about the rollout", burst.Text);
        Assert.Equal(new TextSpan(4, 29), burst.Span);
        Assert.Equal("Hi. ping ashler about the rollout", burst.FullText);
        Assert.Equal(SettleOutcome.Waiting.Instance, d.Settle(3));
    }

    [Fact]
    public void PhraseByPhraseDictationFires()
    {
        // Voice Access inserts words/phrases as they are recognised.
        BurstDetector d = new(string.Empty);
        d.Record("ping ", 0);
        d.Record("ping ashler ", 0.2);
        d.Record("ping ashler about the ", 0.4);
        d.Record("ping ashler about the cooper netties rollout", 0.6);
        Assert.Equal(SettleOutcome.Waiting.Instance, d.Settle(0.9));
        // A run that arrived as several insertions may still have words coming,
        // so SettleMs of quiet is no longer enough to end it.
        Assert.Equal(SettleOutcome.Coalescing.Instance, d.Settle(0.6 + Settle));
        Assert.Equal(string.Empty, d.LastStable);
        Burst burst = ExpectBurst(d.Settle(0.6 + RunQuiet));
        Assert.Equal(new TextSpan(0, 44), burst.Span);
    }

    [Fact]
    public void ShortSingleEventFiresAtTwelveChars()
    {
        BurstDetector d = new("Deploy to ");
        d.Record("Deploy to cooper netties", 0);
        Burst burst = ExpectBurst(d.Settle(Settle));
        Assert.Equal("cooper netties", burst.Text);

        BurstDetector shortRun = new(string.Empty);
        shortRun.Record("ashler", 0);
        // One word-sized insertion could be the first word of a dictated
        // phrase, so it is held until the silence says otherwise.
        Assert.Equal(SettleOutcome.Coalescing.Instance, shortRun.Settle(Settle));
        ExpectSkipped("too short (1 words, 6 units)", shortRun.Settle(RunQuiet));
    }

    [Fact]
    public void OwnRewriteDoesNotRetrigger()
    {
        BurstDetector d = new(string.Empty);
        d.Record("ping ashler about the rollout", 0);
        ExpectBurst(d.Settle(Settle));
        // The engine rewrites the field; the app sees a value change with the new text.
        d.MarkStable("ping Ashlr.AI about the rollout");
        d.Record("ping Ashlr.AI about the rollout", 1.0);
        Assert.False(d.HasPendingChanges);
        Assert.Equal(SettleOutcome.Waiting.Instance, d.Settle(1.0 + Settle));
        // Even without MarkStable, a value-changed event that lands on LastStable is inert.
        d.Record("ping Ashlr.AI about the rollout", 2.0);
        Assert.Equal(SettleOutcome.Waiting.Instance, d.Settle(3.0));
    }

    [Fact]
    public void MultiParagraphGuard()
    {
        BurstDetector d = new(string.Empty);
        d.Record("first line about ashler\nsecond line about versel", 0);
        ExpectSkipped("multi-paragraph", d.Settle(Settle));
        Assert.Equal("first line about ashler\nsecond line about versel", d.LastStable);

        BurstDetector trailing = new(string.Empty);
        trailing.Record("ping ashler about the rollout\n", 0);
        Burst b = ExpectBurst(trailing.Settle(Settle));
        Assert.Equal("ping ashler about the rollout", b.Text);
        Assert.Equal(new TextSpan(0, 29), b.Span);

        BurstDetector onlyNewline = new("abc");
        onlyNewline.Record("abc\n\n\n\n", 0);
        ExpectSkipped("nothing inserted", onlyNewline.Settle(Settle));

        Assert.True(BurstDetector.IsMultiParagraph("a\nb"));
        Assert.False(BurstDetector.IsMultiParagraph("a\n  \n"));
        // Windows line endings are the common case here, unlike on macOS.
        Assert.True(BurstDetector.IsMultiParagraph("a\r\nb"));
        Assert.False(BurstDetector.IsMultiParagraph("a\r\n"));
    }

    [Fact]
    public void CrLfDictationKeepsBothUnitsOutOfTheBurst()
    {
        // Notepad and most Win32 edits use CRLF. A dictated "new line" at the
        // end must leave the burst as a clean single paragraph, or the rewrite
        // would have to re-insert a line break it never owned.
        BurstDetector d = new(string.Empty);
        d.Record("ping ashler about the rollout\r\n", 0);
        Burst burst = ExpectBurst(d.Settle(Settle));
        Assert.Equal("ping ashler about the rollout", burst.Text);
        Assert.Equal(new TextSpan(0, 29), burst.Span);
    }

    [Fact]
    public void Utf16RangeMathWithEmoji()
    {
        string baseText = "Team \U0001F680 update: ";     // rocket is 2 UTF-16 units
        string inserted = "tell mason white about versel \U0001F44D";
        BurstDetector d = new(baseText);
        d.Record(baseText + inserted, 0);
        Burst burst = ExpectBurst(d.Settle(Settle));
        Assert.Equal(baseText.Length, burst.Span.Location);
        Assert.Equal(inserted.Length, burst.Span.Length);
        Assert.Equal(inserted, burst.Text);
        Assert.Equal(inserted, TextDiff.Substring(baseText + inserted, burst.Span));

        // Insertion in the middle, between two emoji.
        string mid = "\U0001F600\U0001F601";
        BurstDetector d2 = new(mid);
        d2.Record("\U0001F600ping ashler about the rollout\U0001F601", 0);
        Burst b2 = ExpectBurst(d2.Settle(Settle));
        Assert.Equal(new TextSpan(2, 29), b2.Span);
        Assert.Equal("ping ashler about the rollout", b2.Text);
    }

    [Fact]
    public void FieldTooLongIsSkipped()
    {
        BurstDetector d = new(string.Empty, new BurstDetector.Config(MaxFieldLength: 30));
        d.Record(string.Concat(Enumerable.Repeat("word ", 10)), 0);
        ExpectSkipped("field longer than 30", d.Settle(Settle));
    }

    [Fact]
    public void DeletionAndReplacementDoNotFire()
    {
        BurstDetector d = new("ping ashler about the rollout");
        d.Record("ping about the rollout", 0);
        ExpectSkipped("nothing inserted", d.Settle(Settle));
        // Selecting a word and dictating a single short word over it is too short.
        d.Record("ping Ashlr about the rollout", 1);
        Assert.Equal(SettleOutcome.Coalescing.Instance, d.Settle(1 + Settle));
        ExpectSkipped("too short (1 words, 6 units)", d.Settle(1 + RunQuiet));
    }

    [Fact]
    public void SettleHonoursConfiguredDelayAndMinWords()
    {
        BurstDetector d = new(string.Empty, new BurstDetector.Config(SettleMs: 1200, MinWords: 5, FewEventsMinChars: 100));
        d.Record("ping ashler about the", 0);
        Assert.Equal(SettleOutcome.Waiting.Instance, d.Settle(0.8));
        Assert.Equal(SettleOutcome.Coalescing.Instance, d.Settle(1.2));
        ExpectSkipped("too short (4 words, 21 units)", d.Settle(RunQuiet));
        d.Record("ping ashler about the cooper netties rollout", 2);
        // Diff against the new baseline: only " cooper netties rollout" is new (3 words), below MinWords 5.
        Assert.Equal(SettleOutcome.Coalescing.Instance, d.Settle(3.2));
        ExpectSkipped("too short (3 words, 23 units)", d.Settle(2 + RunQuiet));
    }

    // ---------------------------------------------------------------------
    // Streamed dictation
    //
    // Windows Voice Access, Wispr Flow and an app's own microphone button all
    // insert a word at a time rather than pasting a finished phrase, and the
    // gaps between spoken words are routinely longer than SettleMs. Deciding at
    // the first gap chopped such a phrase into single words, each "too short",
    // so the whole sentence went uncorrected.

    [Fact]
    public void StreamedDictationWithPausesLongerThanSettleCoalescesIntoOneBurst()
    {
        BurstDetector d = new(string.Empty);
        double now = 0.0;
        string text = string.Empty;
        foreach (string word in new[] { "ping ", "ashler ", "about ", "the ", "cuban ", "eats ", "rollout" })
        {
            text += word;
            d.Record(text, now);
            // The engine asks again SettleMs after each word; the run has to
            // stay pending or the word is dropped on its own.
            Assert.Equal(SettleOutcome.Coalescing.Instance, d.Settle(now + Settle, text.Length));
            now += 0.9;
        }

        double lastWordAt = now - 0.9;
        Burst burst = ExpectBurst(d.Settle(now + RunQuiet, text.Length));
        Assert.Equal("ping ashler about the cuban eats rollout", burst.Text);
        Assert.Equal(new TextSpan(0, 40), burst.Span);
        Assert.Equal(SettleOutcome.Waiting.Instance, d.Settle(lastWordAt + 5, text.Length));
    }

    [Fact]
    public void TypingThenPauseThenDictationCorrectsOnlyTheDictation()
    {
        BurstDetector d = new(string.Empty);
        // Typed by hand, character at a time: still refused.
        double now = Type("Meeting notes. ", d, string.Empty, 0);
        ExpectSkipped("typed, not dictated", d.Settle(now + Settle));
        Assert.Equal("Meeting notes. ", d.LastStable);

        // Then the user pauses and dictates. The burst is the dictated span
        // only — the typed prefix is already the baseline.
        string text = "Meeting notes. ";
        now += 2;
        foreach (string word in new[] { "ping ", "ashler ", "about ", "the ", "rollout" })
        {
            text += word;
            d.Record(text, now);
            Assert.Equal(SettleOutcome.Coalescing.Instance, d.Settle(now + Settle, text.Length));
            now += 0.9;
        }

        Burst burst = ExpectBurst(d.Settle(now + RunQuiet, text.Length));
        Assert.Equal("ping ashler about the rollout", burst.Text);
        Assert.Equal(new TextSpan(15, 29), burst.Span);
    }

    [Fact]
    public void SlowTypingIsNeverCoalescedIntoABurst()
    {
        // The guard that keeps the coalescing window from swallowing ordinary
        // typing is chunk size, not rate: typing one character at a time never
        // produces a MinChunk-sized insertion, however long the pauses are.
        BurstDetector d = new(string.Empty);
        double end = Type("ping ashler about the cuban eats rollout", d, string.Empty, 0, gap: 0.9);
        ExpectSkipped("typed, not dictated", d.Settle(end + Settle));
        Assert.Equal(SettleOutcome.Waiting.Instance, d.Settle(end + 10));
    }

    [Fact]
    public void APasteStillFiresAtSettleWithoutWaitingForTheRunWindow()
    {
        // One insertion that already reads as a burst has nothing to wait for;
        // holding it would add a second of latency to every paste.
        BurstDetector d = new(string.Empty);
        d.Record("ping ashler about the cuban eats rollout", 0);
        ExpectBurst(d.Settle(Settle));
    }

    [Fact]
    public void ACoalescingRunIsCappedByMaxRunMs()
    {
        // Continuous dictation must still be corrected periodically rather than
        // held forever waiting for a silence that never comes.
        BurstDetector d = new(string.Empty, new BurstDetector.Config(MaxRunMs: 3000));
        double now = 0.0;
        string text = string.Empty;
        foreach (string word in new[] { "ping ", "ashler ", "about ", "the ", "rollout " })
        {
            text += word;
            d.Record(text, now);
            now += 0.9;
        }

        ExpectBurst(d.Settle(now));
    }

    [Fact]
    public void HardRefusalsAreNotHeldOpen()
    {
        // Silence cannot turn a multi-paragraph insertion into a single one, so
        // it is refused at SettleMs rather than after the run window.
        BurstDetector d = new(string.Empty);
        d.Record("first line about ashler\nsecond line", 0);
        ExpectSkipped("multi-paragraph", d.Settle(Settle));
    }

    [Fact]
    public void TextDiffDelta()
    {
        Assert.Equal(new TextDiff.Delta(2, 2, 0), TextDiff.ComputeDelta("abc", "abXYc"));
        Assert.Equal(new TextDiff.Delta(3, 0, 0), TextDiff.ComputeDelta("abc", "abc"));
        Assert.Equal(new TextDiff.Delta(0, 3, 0), TextDiff.ComputeDelta(string.Empty, "abc"));
        // One more "a" could have been inserted at any of the four positions;
        // the window is reported with the play that makes it a guess.
        Assert.Equal(new TextDiff.Delta(3, 1, 0, SlideLeft: 3, SlideRight: 0), TextDiff.ComputeDelta("aaa", "aaaa"));
        Assert.Equal(new TextDiff.Delta(1, 1, 1), TextDiff.ComputeDelta("abc", "aXc"));
        Assert.Equal(2, TextDiff.WordCount("  two   words \n"));
    }
}
