using Xunit;

namespace LexiconBar.Tests;

public class NormalizeResponseTests
{
    [Fact]
    public void AFullBodyParses()
    {
        const string json = """
        {
          "input": "ping ashler about the cuban eats rollout",
          "output": "ping Ashlr.AI about the Kubernetes rollout",
          "changed": true,
          "summary": "Fixed 2 words",
          "replacements": [
            {"start": 5, "end": 11, "original": "ashler", "replacement": "Ashlr.AI", "reason": "alias", "confidence": 1},
            {"start": 22, "end": 32, "original": "cuban eats", "canonical": "Kubernetes", "reason": "phonetic", "confidence": 0.82}
          ]
        }
        """;

        NormalizeResponse response = Assert.IsType<NormalizeResponse>(NormalizeResponse.Parse(json));
        Assert.True(response.Changed);
        Assert.Equal("Fixed 2 words", response.Summary);
        Assert.Equal(2, response.Replacements.Count);
        Assert.Equal("Ashlr.AI", response.Replacements[0].Replacement);
        // `canonical` is accepted as an alias for `replacement`.
        Assert.Equal("Kubernetes", response.Replacements[1].Replacement);
        Assert.Equal(0.82, response.Replacements[1].Confidence);
    }

    [Fact]
    public void ChangedIsInferredWhenTheServerOmitsIt()
    {
        Assert.True(NormalizeResponse.Parse("""{"input":"a","output":"b"}""")!.Changed);
        Assert.False(NormalizeResponse.Parse("""{"input":"a","output":"a"}""")!.Changed);
    }

    [Fact]
    public void SummaryFallsBackToACount()
    {
        NormalizeResponse response = NormalizeResponse.Parse(
            """{"output":"x","replacements":[{"original":"a","replacement":"b"}]}""")!;
        Assert.Equal("Fixed 1 word", response.Summary);
    }

    [Fact]
    public void MalformedRepliesNeverThrow()
    {
        Assert.Null(NormalizeResponse.Parse("not json"));
        Assert.Null(NormalizeResponse.Parse("[]"));
        Assert.Null(NormalizeResponse.Parse("""{"input":"a"}"""));   // no output
        // A replacement row missing `original` is dropped, not fatal.
        NormalizeResponse response = NormalizeResponse.Parse(
            """{"output":"x","replacements":[{"replacement":"b"},{"original":"a","replacement":"b"}]}""")!;
        Assert.Single(response.Replacements);
    }
}

public class AppSettingsTests
{
    [Fact]
    public void DefaultsMatchTheMacApp()
    {
        AppSettings settings = new();
        Assert.True(settings.FixEverywhere);
        Assert.True(settings.ShowBubble);
        Assert.False(settings.WatchClipboard);
        Assert.Equal(700, settings.SettleMs);
        Assert.Equal(3, settings.MinWords);
        Assert.Equal(1500, settings.RunQuietMs);
        Assert.Equal(12_000, settings.MaxRunMs);
        Assert.Equal(20_000, settings.MaxFieldLength);
        Assert.Equal(AppExclusions.Defaults, settings.Exclusions);
    }

    [Fact]
    public void RoundTripsThroughJson()
    {
        AppSettings settings = new() { FixEverywhere = false, SettleMs = 900, CliPath = @"C:\npm\lexicon.cmd" };
        settings.Exclusions.Add("myvault");

        AppSettings loaded = AppSettings.FromJson(settings.ToJson());
        Assert.False(loaded.FixEverywhere);
        Assert.Equal(900, loaded.SettleMs);
        Assert.Equal(@"C:\npm\lexicon.cmd", loaded.CliPath);
        Assert.Contains("myvault", loaded.Exclusions);
    }

    [Fact]
    public void ACorruptFileFallsBackToDefaultsRatherThanFailingToStart()
    {
        Assert.True(AppSettings.FromJson("{ this is not json").FixEverywhere);
        Assert.True(AppSettings.FromJson(null).FixEverywhere);
        Assert.True(AppSettings.FromJson("   ").FixEverywhere);
    }

    [Fact]
    public void DetectorConfigCarriesTheTunables()
    {
        BurstDetector.Config config = new AppSettings { SettleMs = 900, MinWords = 5 }.DetectorConfig();
        Assert.Equal(900, config.SettleMs);
        Assert.Equal(5, config.MinWords);
        // The ones the Preferences window does not expose keep their defaults.
        Assert.Equal(4, config.MinChunk);
        Assert.Equal(3, config.FewEvents);
    }
}
