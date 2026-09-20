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
    public void ExcludeIsIdempotentAndIncludeRemovesWildcardsToo()
    {
        AppExclusions exclusions = new(new[] { "keepass*" });
        Assert.True(exclusions.IsExcluded("KeePassXC.exe"));

        // Already matched by the wildcard: nothing is appended.
        exclusions.Exclude("keepassxc");
        Assert.Single(exclusions.ProcessNames);

        // Include removes the wildcard that was matching it.
        exclusions.Include("KeePassXC.exe");
        Assert.False(exclusions.IsExcluded("KeePassXC.exe"));
        Assert.Empty(exclusions.ProcessNames);

        exclusions.Exclude(@"C:\Apps\MyVault.exe");
        Assert.Equal(new[] { "myvault" }, exclusions.ProcessNames);
        Assert.True(exclusions.IsExcluded("myvault.exe"));
    }
}
