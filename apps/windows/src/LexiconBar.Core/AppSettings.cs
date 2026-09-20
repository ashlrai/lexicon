using System.Text.Json;
using System.Text.Json.Serialization;

namespace LexiconBar;

/// <summary>
/// Everything the tray app remembers, serialized to
/// <c>%APPDATA%\LexiconBar\settings.json</c>. Kept in the portable core so the
/// round-trip and the defaults are unit-testable off Windows.
/// </summary>
public sealed class AppSettings
{
    public bool FixEverywhere { get; set; } = true;

    public bool WatchClipboard { get; set; }

    public bool ShowBubble { get; set; } = true;

    /// <summary>Seconds the bubble stays up; 0 means "until dismissed".</summary>
    public double BubbleSeconds { get; set; } = 4;

    public int SettleMs { get; set; } = 700;

    public int MinWords { get; set; } = 3;

    public int RunQuietMs { get; set; } = 1500;

    public int MaxRunMs { get; set; } = 12_000;

    public int MaxFieldLength { get; set; } = 20_000;

    /// <summary>Poll interval for the focused field, in milliseconds. See the notes in <c>docs/WINDOWS-APP.md</c>.</summary>
    public int PollMs { get; set; } = 250;

    /// <summary>Process names excluded from Fix everywhere. See <see cref="AppExclusions"/>.</summary>
    public List<string> Exclusions { get; set; } = AppExclusions.Defaults.ToList();

    /// <summary>Path to the <c>lexicon</c> CLI, for Open lexicon file and Run doctor. Empty means "search PATH".</summary>
    public string CliPath { get; set; } = string.Empty;

    public BurstDetector.Config DetectorConfig() => new(
        SettleMs: SettleMs,
        MinWords: MinWords,
        MaxFieldLength: MaxFieldLength,
        RunQuietMs: RunQuietMs,
        MaxRunMs: MaxRunMs);

    private static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.Never,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    public string ToJson() => JsonSerializer.Serialize(this, Json);

    /// <summary>Defaults when the file is missing or unreadable — never an exception at startup.</summary>
    public static AppSettings FromJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new AppSettings();
        try
        {
            return JsonSerializer.Deserialize<AppSettings>(json, Json) ?? new AppSettings();
        }
        catch (JsonException)
        {
            return new AppSettings();
        }
    }

    public static string DefaultPath(string appDataDirectory) =>
        Path.Combine(appDataDirectory, "LexiconBar", "settings.json");

    public static AppSettings Load(string path)
    {
        try
        {
            return File.Exists(path) ? FromJson(File.ReadAllText(path)) : new AppSettings();
        }
        catch (IOException)
        {
            return new AppSettings();
        }
        catch (UnauthorizedAccessException)
        {
            return new AppSettings();
        }
    }

    public void Save(string path)
    {
        string? directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        File.WriteAllText(path, ToJson());
    }
}
