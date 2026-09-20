namespace LexiconBar;

/// <summary>
/// The labels UI Automation gives us for a field and the window it lives in.
/// All optional: most apps fill in only one or two.
///
/// The mapping from the macOS names is: <c>Identifier</c> is
/// <c>AutomationId</c>, <c>Placeholder</c> is <c>HelpText</c> (Win32 and
/// Chromium both surface a placeholder there) plus the ARIA placeholder where
/// it exists, <c>Title</c> is <c>Name</c>, <c>RoleDescription</c> is
/// <c>LocalizedControlType</c>, and <c>ClassName</c> has no macOS counterpart
/// but is worth checking because Win32 dialogs name their edit controls.
/// </summary>
public sealed record FieldHints(
    string? Identifier = null,
    string? Placeholder = null,
    string? Title = null,
    string? RoleDescription = null,
    string? Help = null,
    string? Description = null,
    string? ClassName = null,
    string? WindowTitle = null)
{
    public IEnumerable<string?> All()
    {
        yield return Identifier;
        yield return Placeholder;
        yield return Title;
        yield return RoleDescription;
        yield return Help;
        yield return Description;
        yield return ClassName;
        yield return WindowTitle;
    }
}

/// <summary>
/// A process-name list always lags reality: a password manager we have never
/// heard of ships tomorrow, and <see cref="AppExclusions"/> does not know about
/// it. UIA's <c>IsPassword</c> only protects the literal masked input, so in
/// any manager we do not exclude the *ordinary* fields are still fair game — an
/// item's notes, a custom field holding a secret, a TOTP seed box, a vault
/// search field echoing a saved username. A burst in one of those would be read
/// and POSTed to the local API.
///
/// This is the second, name-independent guard: refuse a field whose own labels
/// suggest it holds a secret, in any app, and refuse any field inside a window
/// whose title says the same. It is deliberately a *refusal* heuristic — a
/// false positive costs one uncorrected sentence, a false negative sends a
/// secret over the wire — but it still has to leave ordinary writing alone, so
/// matching is on whole words, never substrings. "Notes" is not "note your
/// password", and "shipping" must never match "pin".
///
/// The vocabulary is kept character-for-character in step with
/// <c>apps/macos/LexiconBar/Sources/LexiconBarKit/SecretFieldHeuristic.swift</c>.
/// </summary>
public static class SecretFieldHeuristic
{
    /// <summary>
    /// Terms that mark a field as holding a secret. Each is matched as a
    /// contiguous run of whole words, so "api key" matches <c>apiKey</c>,
    /// <c>api_key</c> and "API Key" but never "apikeyboard".
    /// </summary>
    public static readonly IReadOnlyList<string> Vocabulary = new[]
    {
        "password", "passwords", "passphrase", "passcode",
        "secret", "secrets", "token", "api key", "apikey", "access key",
        "private key", "secret key", "signing key", "license key",
        "seed", "seed phrase", "mnemonic", "recovery", "recovery code",
        "pin", "pin code", "cvv", "cvc", "security code", "verification code",
        "otp", "totp", "one time code", "one time password", "2fa", "mfa",
        "credential", "credentials", "keychain", "vault",
        "card number", "account number", "routing number", "social security",
    };

    /// <summary>
    /// The term that made the field look like a secret, or null when nothing
    /// matched. Returning the term (rather than a bool) lets the caller say
    /// *why* it skipped in the log.
    /// </summary>
    public static string? Match(FieldHints hints)
    {
        foreach (string? hint in hints.All())
        {
            if (MatchText(hint) is string term) return term;
        }
        return null;
    }

    /// <summary>The term matched in a single label, or null.</summary>
    public static string? MatchText(string? text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        List<string> words = Words(text);
        if (words.Count == 0) return null;
        foreach (string term in Vocabulary)
        {
            List<string> termWords = Words(term);
            if (termWords.Count == 0) continue;
            if (ContainsRun(words, termWords)) return term;
        }
        return null;
    }

    /// <summary>True when <paramref name="needle"/> appears in <paramref name="haystack"/> as a contiguous run.</summary>
    private static bool ContainsRun(List<string> haystack, List<string> needle)
    {
        if (needle.Count > haystack.Count) return false;
        for (int start = 0; start <= haystack.Count - needle.Count; start++)
        {
            bool matched = true;
            for (int offset = 0; offset < needle.Count; offset++)
            {
                if (haystack[start + offset] == needle[offset]) continue;
                matched = false;
                break;
            }
            if (matched) return true;
        }
        return false;
    }

    /// <summary>
    /// Splits a label into lowercased words, breaking on anything that is not a
    /// letter or a digit and on camel-case humps, so an automation id like
    /// <c>totpSeedField</c> or <c>api_key</c> becomes real words. A trailing "s"
    /// is dropped from longer words so "Passwords" matches "password" without
    /// "pins" having to be listed separately.
    /// </summary>
    internal static List<string> Words(string text)
    {
        List<string> words = new();
        System.Text.StringBuilder current = new();
        char? previous = null;

        void Flush()
        {
            if (current.Length == 0) return;
            words.Add(Singular(current.ToString().ToLowerInvariant()));
            current.Clear();
        }

        for (int index = 0; index < text.Length; index++)
        {
            char character = text[index];
            if (!char.IsLetter(character) && !char.IsDigit(character))
            {
                Flush();
                previous = null;
                continue;
            }

            if (previous is char prev)
            {
                // Digit/letter boundaries, both ways. This has to be symmetric
                // or a hint and the term it should match tokenize differently:
                // "2FA" would be 2|FA while the term "2fa" stayed one word, and
                // the guard would miss it.
                if (char.IsDigit(character) != char.IsDigit(prev))
                {
                    Flush();
                }
                else if (char.IsUpper(character))
                {
                    // camelCase / PascalCase / acronym boundaries:
                    // "apiKey" -> api|Key, "APIKey" -> API|Key.
                    char? next = index + 1 < text.Length ? text[index + 1] : null;
                    if (char.IsLower(prev) || (char.IsUpper(prev) && next is char n && char.IsLower(n)))
                    {
                        Flush();
                    }
                }
            }

            current.Append(character);
            previous = character;
        }

        Flush();
        return words;
    }

    /// <summary>
    /// Crude but predictable singularization: only a trailing "s" on a word long
    /// enough that dropping it cannot turn a real word into a term ("pins" -&gt;
    /// "pin", but "is" is left alone).
    /// </summary>
    private static string Singular(string word)
    {
        if (word.Length <= 3 || !word.EndsWith('s') || word.EndsWith("ss", StringComparison.Ordinal)) return word;
        return word[..^1];
    }
}
