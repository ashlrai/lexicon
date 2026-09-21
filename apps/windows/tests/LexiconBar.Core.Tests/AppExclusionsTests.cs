using Xunit;

namespace LexiconBar.Tests;

public class AppExclusionsTests
{
    [Theory]
    [InlineData("WindowsTerminal.exe")]
    [InlineData(@"C:\Program Files\WindowsApps\Microsoft.WindowsTerminal_1.0\WindowsTerminal.exe")]
    [InlineData("powershell")]
    [InlineData("pwsh.exe")]
    [InlineData("cmd.exe")]
    [InlineData("conhost.exe")]
    [InlineData("wezterm-gui.exe")]
    [InlineData("mstsc.exe")]
    [InlineData("1Password.exe")]
    [InlineData("1PasswordBrowserSupport.exe")]   // vendor prefix, not an exact id
    [InlineData("Bitwarden.exe")]
    [InlineData("KeePassXC.exe")]
    [InlineData("KeePass2.exe")]
    [InlineData("Keeper Password Manager.exe")]
    [InlineData("CredentialUIBroker.exe")]
    public void ExcludedByDefault(string process) => Assert.True(new AppExclusions().IsExcluded(process));

    [Theory]
    [InlineData("notepad.exe")]
    [InlineData("wordpad.exe")]
    [InlineData("chrome.exe")]
    [InlineData("msedge.exe")]
    [InlineData("Code.exe")]
    [InlineData("slack.exe")]
    [InlineData("Claude.exe")]
    [InlineData("WINWORD.EXE")]
    [InlineData("")]
    [InlineData(null)]
    public void NotExcludedByDefault(string? process) => Assert.False(new AppExclusions().IsExcluded(process));

    [Fact]
    public void NormalizeStripsPathAndExtensionAndCase()
    {
        Assert.Equal("notepad", AppExclusions.Normalize(@"C:\Windows\System32\notepad.exe"));
        Assert.Equal("notepad", AppExclusions.Normalize("NOTEPAD.EXE"));
        Assert.Equal("notepad", AppExclusions.Normalize("notepad"));
        Assert.Equal(string.Empty, AppExclusions.Normalize("   "));
    }

    [Fact]
    public void ExcludeIsIdempotent()
    {
        AppExclusions exclusions = new(new[] { "keepass*" });
        Assert.True(exclusions.IsExcluded("KeePassXC.exe"));

        // Already matched by the wildcard: nothing is appended.
        exclusions.Exclude("keepassxc");
        Assert.Single(exclusions.ProcessNames);

        exclusions.Exclude(@"C:\Apps\MyVault.exe");
        Assert.Equal(new[] { "keepass*", "myvault" }, exclusions.ProcessNames);
        Assert.True(exclusions.IsExcluded("myvault.exe"));
    }

    [Fact]
    public void IncludeRemovesTheExactEntryAndSaysSo()
    {
        AppExclusions exclusions = new(new[] { "keepass*", "myvault" });

        Assert.Null(exclusions.Include(@"C:\Apps\MyVault.exe"));
        Assert.False(exclusions.IsExcluded("myvault"));
        Assert.Equal(new[] { "keepass*" }, exclusions.ProcessNames);
    }

    /// <summary>
    /// The password-manager defaults are vendor prefixes on purpose. Removing
    /// the whole prefix because the user re-enabled one of the vendor's
    /// executables would silently unprotect every other one, and
    /// <see cref="AppExclusions.Exclude"/> only ever adds back an exact name,
    /// so the rule would be gone for good.
    /// </summary>
    [Fact]
    public void IncludeLeavesAWildcardAloneAndReportsThatItStillMatches()
    {
        AppExclusions exclusions = new(new[] { "1password*", "1password" });

        Assert.Equal("1password*", exclusions.Include("1Password.exe"));
        Assert.True(exclusions.IsExcluded("1Password.exe"));
        Assert.True(exclusions.IsExcluded("1PasswordBrowserSupport.exe"));
        Assert.Equal(new[] { "1password*" }, exclusions.ProcessNames);
        Assert.Equal("1password*", exclusions.MatchingEntry("1Password.exe"));
    }

    [Fact]
    public void IncludeOnAnAppThatWasNeverExcludedChangesNothing()
    {
        AppExclusions exclusions = new(new[] { "keepass*" });

        Assert.Null(exclusions.Include("notepad.exe"));
        Assert.Equal(new[] { "keepass*" }, exclusions.ProcessNames);
    }

    [Fact]
    public void MatchingEntryNamesTheRuleAsTheUserWroteIt()
    {
        AppExclusions exclusions = new(new[] { " KeePass* ", "MyVault.exe" });

        Assert.Equal(" KeePass* ", exclusions.MatchingEntry("keepassxc"));
        Assert.Equal("MyVault.exe", exclusions.MatchingEntry(@"C:\Apps\myvault.exe"));
        Assert.Null(exclusions.MatchingEntry("notepad"));
        Assert.Null(exclusions.MatchingEntry(null));
    }

    // --------------------------------------------------------- an empty list

    /// <summary>
    /// Clearing the list means "exclude nothing", the same as on macOS, and it
    /// is honoured rather than quietly refilled. What it must not be is silent,
    /// which is what <see cref="AppExclusions.IsEmpty"/> exists for: the
    /// preferences window swaps the hint for a warning and asks before saving
    /// one. A list that is only blank lines is the same state and gets the same
    /// answer, because that is what a half-cleared textbox produces.
    /// </summary>
    [Fact]
    public void AnEmptyListExcludesNothingAndKnowsIt()
    {
        AppExclusions cleared = new(Array.Empty<string>());

        Assert.True(cleared.IsEmpty);
        Assert.False(cleared.IsExcluded("1Password.exe"));
        Assert.False(cleared.IsExcluded("lsass.exe"));
        Assert.False(cleared.IsExcluded("WindowsTerminal.exe"));
        Assert.Null(cleared.MatchingEntry("logonui.exe"));
    }

    [Fact]
    public void BlankLinesAreTheSameAsEmpty()
    {
        Assert.True(new AppExclusions(new[] { "  ", "\t", string.Empty }).IsEmpty);
        Assert.False(new AppExclusions(new[] { "  ", "notepad" }).IsEmpty);
    }

    /// <summary>
    /// Only "nobody has configured this" falls back to the defaults. That is
    /// the null the watcher starts from before settings are pushed into it, and
    /// it is deliberately a different state from a list the user emptied.
    /// </summary>
    [Fact]
    public void OnlyAnUnconfiguredListFallsBackToTheDefaults()
    {
        Assert.False(new AppExclusions().IsEmpty);
        Assert.False(new AppExclusions(null).IsEmpty);
        Assert.Equal(AppExclusions.Defaults.ToArray(), new AppExclusions(null).ProcessNames);
    }

    [Fact]
    public void TheEmptyWarningNamesWhatIsNoLongerCovered()
    {
        // The words live next to the defaults they describe so the two cannot
        // drift; if the defaults stop covering one of these, this fails.
        Assert.Contains("terminals", AppExclusions.EmptyWarning);
        Assert.Contains("credential", AppExclusions.EmptyWarning);
        Assert.Contains("password managers", AppExclusions.EmptyWarning);
        Assert.DoesNotContain("\u2014", AppExclusions.EmptyWarning);
    }
}
