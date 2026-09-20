using Xunit;

namespace LexiconBar.Tests;

/// <summary>
/// A port of <c>SecretFieldHeuristicTests.swift</c> plus the Windows-shaped
/// cases (Win32 class names, UIA automation ids, Credential Manager titles).
///
/// The asymmetry to keep in mind while reading these: a false positive costs
/// one uncorrected sentence, a false negative POSTs somebody's password to an
/// HTTP endpoint. The "leaves ordinary writing alone" cases exist so the
/// refusal stays narrow enough to be worth having.
/// </summary>
public class SecretFieldHeuristicTests
{
    [Theory]
    [InlineData("Password")]
    [InlineData("password")]
    [InlineData("Master Password")]
    [InlineData("Confirm passphrase")]
    [InlineData("Passcode")]
    [InlineData("apiKey")]
    [InlineData("api_key")]
    [InlineData("API Key")]
    [InlineData("APIKeyField")]
    [InlineData("totpSeedField")]
    [InlineData("Recovery code")]
    [InlineData("Enter your PIN")]
    [InlineData("CVV")]
    [InlineData("Security code")]
    [InlineData("2FA")]
    [InlineData("2fa code")]
    [InlineData("MFA token")]
    [InlineData("Private key")]
    [InlineData("Seed phrase")]
    [InlineData("Card number")]
    [InlineData("Routing number")]
    [InlineData("Social Security Number")]
    [InlineData("Vault")]
    [InlineData("Keychain")]
    [InlineData("credentials")]
    public void SecretLookingLabelsAreRefused(string label) => Assert.NotNull(SecretFieldHeuristic.MatchText(label));

    [Theory]
    [InlineData("Notes")]
    [InlineData("Shipping address")]
    [InlineData("Message")]
    [InlineData("Subject")]
    [InlineData("Search")]
    [InlineData("apikeyboard")]
    [InlineData("Pinterest")]
    [InlineData("Spinning up the cluster")]
    [InlineData("Untitled - Notepad")]
    [InlineData("Document1 - Word")]
    [InlineData("Compose")]
    [InlineData("Tokenizer settings")]   // "tokenizer" is one word, not "token"
    public void OrdinaryLabelsAreLeftAlone(string label) => Assert.Null(SecretFieldHeuristic.MatchText(label));

    [Fact]
    public void MatchingIsOnWholeWordsNotSubstrings()
    {
        // The two cases the macOS comment calls out by name.
        Assert.Null(SecretFieldHeuristic.MatchText("shipping"));
        Assert.Null(SecretFieldHeuristic.MatchText("note your thoughts"));
        Assert.NotNull(SecretFieldHeuristic.MatchText("note your password"));
    }

    [Fact]
    public void TrailingSIsSingularizedOnlyWhenItIsSafe()
    {
        Assert.Equal("pin", SecretFieldHeuristic.MatchText("pins"));
        Assert.Equal("password", SecretFieldHeuristic.MatchText("Passwords"));
        Assert.Equal(new[] { "password" }, SecretFieldHeuristic.Words("passwords"));
        // Short words and -ss words are left alone.
        Assert.Equal(new[] { "is" }, SecretFieldHeuristic.Words("is"));
        Assert.Equal(new[] { "access" }, SecretFieldHeuristic.Words("access"));
        Assert.Equal(new[] { "address" }, SecretFieldHeuristic.Words("address"));
    }

    /// <summary>
    /// A known, shared limitation rather than a bug to fix here: the acronym
    /// rule splits a pluralized all-caps acronym at the lowercase "s", so
    /// "PINs" tokenizes as "pi" + "ns" and misses. The macOS tokenizer does
    /// exactly the same thing. It is pinned here so that if either port is ever
    /// "fixed", the two are fixed together — the heuristic is only useful while
    /// both apps refuse the same fields.
    /// </summary>
    [Fact]
    public void PluralizedAllCapsAcronymsAreAKnownMiss()
    {
        Assert.Equal(new[] { "pi", "ns" }, SecretFieldHeuristic.Words("PINs"));
        Assert.Null(SecretFieldHeuristic.MatchText("PINs"));
        // The singular all-caps form is fine, which is the form real UI uses.
        Assert.Equal("pin", SecretFieldHeuristic.MatchText("PIN"));
        Assert.Equal("pin", SecretFieldHeuristic.MatchText("Enter PIN"));
    }

    [Fact]
    public void CamelCaseAndAcronymsSplitIntoRealWords()
    {
        Assert.Equal(new[] { "api", "key" }, SecretFieldHeuristic.Words("apiKey"));
        Assert.Equal(new[] { "api", "key" }, SecretFieldHeuristic.Words("APIKey"));
        Assert.Equal(new[] { "api", "key" }, SecretFieldHeuristic.Words("api_key"));
        Assert.Equal(new[] { "totp", "seed", "field" }, SecretFieldHeuristic.Words("totpSeedField"));
        // Digit boundaries are symmetric, or "2FA" would not match the term "2fa".
        Assert.Equal(SecretFieldHeuristic.Words("2fa"), SecretFieldHeuristic.Words("2FA"));
    }

    [Fact]
    public void AnySingleHintIsEnoughIncludingTheWindowTitle()
    {
        // The field itself looks innocent; the window it sits in does not. This
        // is the 1Password-item-notes case.
        FieldHints hints = new(
            Identifier: "field3",
            Title: "Notes",
            WindowTitle: "Bitwarden - My Vault");
        Assert.Equal("vault", SecretFieldHeuristic.Match(hints));

        // Win32 credential dialogs name the control, not the window.
        Assert.Equal("password", SecretFieldHeuristic.Match(new FieldHints(ClassName: "PasswordBox")));
        Assert.Equal("credential", SecretFieldHeuristic.Match(new FieldHints(Title: "Windows Credential Manager")));

        Assert.Null(SecretFieldHeuristic.Match(new FieldHints(Title: "Notes", WindowTitle: "Untitled - Notepad")));
        Assert.Null(SecretFieldHeuristic.Match(new FieldHints()));
    }
}
