namespace LexiconBar;

/// <summary>
/// A half-open span of a string, in UTF-16 code units — which for a .NET
/// <see cref="string"/> is simply "characters", the same unit the macOS app
/// uses for <c>NSRange</c> and the same unit UI Automation's
/// <c>TextPatternRange</c> offsets come out in once you measure them with
/// <c>GetText().Length</c>. Keeping the two ports on the same unit is what
/// lets the burst tests be shared line for line.
/// </summary>
public readonly record struct TextSpan(int Location, int Length)
{
    public int End => Location + Length;

    public override string ToString() => $"[{Location}, {Length}]";
}

/// <summary>
/// The UTF-16 diff helpers shared by the burst detector and the splice math.
/// Ported from <c>apps/macos/LexiconBar/Sources/LexiconBarKit/BurstDetector.swift</c>;
/// the behaviour is meant to be identical, and the unit tests are ported too.
/// </summary>
public static class TextDiff
{
    /// <summary>
    /// The span of <c>new</c> that is not shared with <c>old</c>: the common
    /// prefix and suffix (never overlapping) are stripped and what remains is
    /// the insertion. <see cref="Removed"/> is the corresponding span of
    /// <c>old</c>.
    ///
    /// A prefix/suffix diff cannot always say *where* an insertion happened.
    /// Dictating "ping ashler ..." in front of a field that already reads
    /// "ping Ashlr.AI ..." shares the leading "ping ", so the stripped window
    /// starts five units late and runs five units into the old text — a span
    /// that is textually consistent but is not what was inserted. Rewriting
    /// that window splices the correction into the middle of a word and leaves
    /// the rest of the burst untouched. <see cref="SlideLeft"/> /
    /// <see cref="SlideRight"/> measure how far the window could move and
    /// still produce <c>new</c>; <see cref="Anchored"/> says the caret pinned
    /// it, so the position is known rather than guessed.
    /// </summary>
    public readonly record struct Delta(
        int Location,
        int Inserted,
        int Removed,
        int SlideLeft = 0,
        int SlideRight = 0,
        bool Anchored = false)
    {
        public TextSpan InsertedSpan => new(Location, Inserted);

        /// <summary>
        /// The insertion could have happened somewhere else and nothing pinned
        /// it down. The caller must not rewrite a window it only guessed at.
        /// </summary>
        public bool IsAmbiguous => !Anchored && (SlideLeft > 0 || SlideRight > 0);
    }

    /// <param name="caretEnd">
    /// The UTF-16 offset the insertion point sits at now. After a paste or a
    /// dictation insert it is the end of what arrived, which is what resolves
    /// an ambiguous window. Pass <c>null</c> when it is unknown.
    /// </param>
    public static Delta ComputeDelta(string oldText, string newText, int? caretEnd = null)
    {
        ArgumentNullException.ThrowIfNull(oldText);
        ArgumentNullException.ThrowIfNull(newText);

        int prefix = 0;
        int maxPrefix = Math.Min(oldText.Length, newText.Length);
        while (prefix < maxPrefix && oldText[prefix] == newText[prefix]) prefix++;

        int suffix = 0;
        int maxSuffix = maxPrefix - prefix;
        while (suffix < maxSuffix
               && oldText[oldText.Length - 1 - suffix] == newText[newText.Length - 1 - suffix]) suffix++;

        int location = prefix;
        int inserted = newText.Length - prefix - suffix;
        int removed = oldText.Length - prefix - suffix;
        if (removed != 0 || inserted <= 0) return new Delta(location, inserted, removed);

        // How far the window can slide while `newText` stays the same: one unit
        // to the left whenever the unit before the window equals the last unit
        // in it, and one to the right whenever the unit after it equals the first.
        int left = 0;
        while (location - left > 0 && newText[location - left - 1] == newText[location - left + inserted - 1]) left++;
        int right = 0;
        while (location + inserted + right < newText.Length
               && newText[location + right] == newText[location + inserted + right]) right++;

        if (caretEnd is int caret && caret - inserted >= location - left && caret - inserted <= location + right)
        {
            int anchoredLocation = caret - inserted;
            int shift = anchoredLocation - location;
            return new Delta(anchoredLocation, inserted, 0, left + shift, right - shift, Anchored: true);
        }

        return new Delta(location, inserted, 0, left, right);
    }

    /// <summary>Substring by UTF-16 span; null when the span does not fit.</summary>
    public static string? Substring(string text, TextSpan span)
    {
        if (text is null) return null;
        if (span.Location < 0 || span.Length < 0 || span.End > text.Length) return null;
        return text.Substring(span.Location, span.Length);
    }

    /// <summary>
    /// Replaces <paramref name="span"/> of <paramref name="text"/> with
    /// <paramref name="replacement"/>; null when the span does not fit (the
    /// caller must then leave the field alone).
    /// </summary>
    public static string? Splice(string text, TextSpan span, string replacement)
    {
        if (text is null || replacement is null) return null;
        if (span.Location < 0 || span.Length < 0 || span.End > text.Length) return null;
        return string.Concat(text.AsSpan(0, span.Location), replacement, text.AsSpan(span.End));
    }

    public static int WordCount(string text)
    {
        if (string.IsNullOrEmpty(text)) return 0;
        int words = 0;
        bool inWord = false;
        foreach (char c in text)
        {
            if (char.IsWhiteSpace(c)) { inWord = false; continue; }
            if (!inWord) { inWord = true; words++; }
        }
        return words;
    }

    /// <summary>
    /// The same set Swift's <c>Character.isNewline</c> covers, so a burst that
    /// the Mac app calls multi-paragraph is called multi-paragraph here too.
    /// </summary>
    // Written with code points rather than character literals on purpose:
    // U+2028 and U+2029 are line terminators to the C# lexer itself, so a
    // source file that puts them inside a char literal does not compile.
    public static bool IsNewline(char c) => c is
        '\n' or '\r' or (char)0x000B or (char)0x000C
        or (char)0x0085 or (char)0x2028 or (char)0x2029;

    public static bool ContainsNewline(string text)
    {
        foreach (char c in text)
        {
            if (IsNewline(c)) return true;
        }
        return false;
    }
}
