using Xunit;

namespace LexiconBar.Tests;

public class ServePathsTests
{
    private static Dictionary<string, string?> Env(params (string Key, string? Value)[] pairs)
    {
        Dictionary<string, string?> env = new(StringComparer.OrdinalIgnoreCase);
        foreach ((string key, string? value) in pairs) env[key] = value;
        return env;
    }

    [Fact]
    public void TheDefaultWindowsPathIsUserProfileDotConfig()
    {
        // This is the assertion that documents the surprise: the Node CLI has no
        // win32 branch in resolvePaths, so `os.homedir()/.config/lexicon` is
        // where serve.json really lands on Windows — not %APPDATA%.
        IReadOnlyList<string> candidates = ServePaths.Candidates(
            Env(("APPDATA", @"C:\Users\mason\AppData\Roaming")),
            @"C:\Users\mason");

        Assert.Equal(Path.Combine(@"C:\Users\mason", ".config", "lexicon", "serve.json"), candidates[0]);
        // %APPDATA% is still probed, after it.
        Assert.Contains(Path.Combine(@"C:\Users\mason\AppData\Roaming", "lexicon", "serve.json"), candidates);
    }

    [Fact]
    public void LexiconPathWinsAndIsTakenAsAFileNotADirectory()
    {
        IReadOnlyList<string> candidates = ServePaths.Candidates(
            Env(("LEXICON_PATH", @"D:\lex\custom\lexicon.yaml")),
            @"C:\Users\mason");
        Assert.Equal(Path.Combine(@"D:\lex\custom", "serve.json"), candidates[0]);
    }

    [Fact]
    public void ALexiconPathWithForwardSlashesIsSplitToo()
    {
        // Windows accepts forward slashes, and LEXICON_PATH set from Git Bash
        // or copied out of the docs routinely has them.
        IReadOnlyList<string> candidates = ServePaths.Candidates(
            Env(("LEXICON_PATH", "D:/lex/custom/lexicon.yaml")),
            @"C:\Users\mason");
        Assert.Equal(Path.Combine("D:/lex/custom", "serve.json"), candidates[0]);
    }

    [Fact]
    public void ABareLexiconFileNameContributesNoCandidate()
    {
        IReadOnlyList<string> candidates = ServePaths.Candidates(
            Env(("LEXICON_PATH", "lexicon.yaml")),
            @"C:\Users\mason");
        Assert.Single(candidates);
        Assert.Equal(Path.Combine(@"C:\Users\mason", ".config", "lexicon", "serve.json"), candidates[0]);
    }

    [Fact]
    public void XdgConfigHomeIsHonouredJustLikeOnTheNodeSide()
    {
        IReadOnlyList<string> candidates = ServePaths.Candidates(
            Env(("XDG_CONFIG_HOME", @"D:\xdg")),
            @"C:\Users\mason");
        Assert.Equal(Path.Combine(@"D:\xdg", "lexicon", "serve.json"), candidates[0]);
    }

    [Fact]
    public void EmptyEnvironmentVariablesAreIgnoredNotTreatedAsRoot()
    {
        IReadOnlyList<string> candidates = ServePaths.Candidates(
            Env(("LEXICON_PATH", ""), ("XDG_CONFIG_HOME", ""), ("APPDATA", null)),
            @"C:\Users\mason");
        Assert.Single(candidates);
    }

    [Fact]
    public void LocateReturnsTheFirstOneThatExists()
    {
        Dictionary<string, string?> env = Env(("APPDATA", @"C:\Users\mason\AppData\Roaming"));
        string appData = Path.Combine(@"C:\Users\mason\AppData\Roaming", "lexicon", "serve.json");
        Assert.Equal(appData, ServePaths.Locate(env, @"C:\Users\mason", path => path == appData));
        Assert.Null(ServePaths.Locate(env, @"C:\Users\mason", _ => false));
    }

    [Fact]
    public void CredentialsParseWithAndWithoutAPort()
    {
        ServeCredentials credentials = Assert.IsType<ServeCredentials>(
            ServeCredentials.Parse("""{"port":41733,"token":"0123456789abcdef0123456789abcdef"}"""));
        Assert.Equal(41733, credentials.Port);
        Assert.Equal("0123456789abcdef0123456789abcdef", credentials.Token);
        Assert.Equal("http://127.0.0.1:41733/", credentials.BaseUri.ToString());

        // Missing port falls back to the fixed default, as the Mac client does.
        Assert.Equal(
            ServeCredentials.DefaultPort,
            Assert.IsType<ServeCredentials>(ServeCredentials.Parse("""{"token":"abc"}""")).Port);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("""{"port":41733}""")]
    [InlineData("""{"token":""}""")]
    [InlineData("""{"token":123}""")]
    public void UnusableServeJsonParsesToNullRatherThanThrowing(string json) =>
        Assert.Null(ServeCredentials.Parse(json));
}
