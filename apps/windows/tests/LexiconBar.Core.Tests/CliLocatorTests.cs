using Xunit;

namespace LexiconBar.Tests;

public class CliLocatorTests
{
    [Fact]
    public void CmdComesBeforeExeBecauseNpmShipsAShim()
    {
        IReadOnlyList<string> candidates = CliLocator.Candidates(null, new[] { @"C:\tools" }, null);
        int cmd = candidates.ToList().FindIndex(p => p.EndsWith("lexicon.cmd", StringComparison.OrdinalIgnoreCase));
        int exe = candidates.ToList().FindIndex(p => p.EndsWith("lexicon.exe", StringComparison.OrdinalIgnoreCase));
        Assert.True(cmd >= 0 && exe >= 0);
        Assert.True(cmd < exe, "npm installs lexicon.cmd, not lexicon.exe");
    }

    [Fact]
    public void AConfiguredPathWinsOutright()
    {
        IReadOnlyList<string> candidates = CliLocator.Candidates(
            @"D:\custom\lexicon.cmd", new[] { @"C:\tools" }, @"C:\Users\mason\AppData\Roaming");
        Assert.Equal(@"D:\custom\lexicon.cmd", candidates[0]);
    }

    [Fact]
    public void TheGlobalNpmShimDirectoryIsProbed()
    {
        IReadOnlyList<string> candidates = CliLocator.Candidates(
            null, Array.Empty<string>(), @"C:\Users\mason\AppData\Roaming");
        Assert.Contains(Path.Combine(@"C:\Users\mason\AppData\Roaming", "npm", "lexicon.cmd"), candidates);
    }

    [Fact]
    public void DuplicatePathEntriesDoNotProduceDuplicateCandidates()
    {
        IReadOnlyList<string> candidates = CliLocator.Candidates(
            null, new[] { @"C:\tools", @"c:\TOOLS" }, null);
        Assert.Equal(CliLocator.Extensions.Count, candidates.Count);
    }

    [Fact]
    public void LocateReturnsTheFirstExistingCandidate()
    {
        string wanted = Path.Combine(@"C:\tools", "lexicon.exe");
        Assert.Equal(
            wanted,
            CliLocator.Locate(null, new[] { @"C:\tools" }, null, path => path == wanted));
        Assert.Null(CliLocator.Locate(null, new[] { @"C:\tools" }, null, _ => false));
    }

    [Fact]
    public void SplitPathToleratesTrailingSemicolonsAndQuotes()
    {
        Assert.Equal(
            new[] { @"C:\tools", @"C:\Program Files\nodejs" },
            CliLocator.SplitPath(@"C:\tools;;""C:\Program Files\nodejs"";").ToArray());
        Assert.Empty(CliLocator.SplitPath(null));
    }
}
