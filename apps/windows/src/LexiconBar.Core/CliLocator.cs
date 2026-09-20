namespace LexiconBar;

/// <summary>
/// Finding the <c>lexicon</c> CLI, which the tray needs only for "Open lexicon
/// file" and "Run doctor" — everything on the hot path goes through the local
/// HTTP API instead.
///
/// npm on Windows installs a <c>lexicon.cmd</c> shim rather than an executable,
/// which is why the order below puts <c>.cmd</c> first: <c>lexicon.exe</c> does
/// not exist, and a <c>ProcessStartInfo</c> naming a bare <c>lexicon</c> will
/// not find the shim unless <c>UseShellExecute</c> is on. The pure list makes
/// that testable off Windows.
/// </summary>
public static class CliLocator
{
    /// <summary>Extensions npm and friends install under, best first.</summary>
    public static readonly IReadOnlyList<string> Extensions = new[] { ".cmd", ".exe", ".bat", ".ps1", string.Empty };

    /// <summary>
    /// Every path worth trying, best first and without duplicates.
    /// </summary>
    /// <param name="configured">The path from Preferences; wins outright when set.</param>
    /// <param name="pathDirectories">The directories of <c>%PATH%</c>.</param>
    /// <param name="appData"><c>%APPDATA%</c>, where a global npm install puts its shims.</param>
    public static IReadOnlyList<string> Candidates(
        string? configured,
        IEnumerable<string> pathDirectories,
        string? appData)
    {
        List<string> candidates = new();

        void Add(string path)
        {
            if (path.Length > 0 && !candidates.Contains(path, StringComparer.OrdinalIgnoreCase)) candidates.Add(path);
        }

        if (!string.IsNullOrWhiteSpace(configured)) Add(configured.Trim());

        foreach (string directory in pathDirectories)
        {
            if (string.IsNullOrWhiteSpace(directory)) continue;
            foreach (string extension in Extensions)
            {
                Add(Path.Combine(directory.Trim(), "lexicon" + extension));
            }
        }

        if (!string.IsNullOrWhiteSpace(appData))
        {
            foreach (string extension in Extensions)
            {
                Add(Path.Combine(appData, "npm", "lexicon" + extension));
            }
        }

        return candidates;
    }

    /// <summary>The first candidate that exists, or null.</summary>
    public static string? Locate(
        string? configured,
        IEnumerable<string> pathDirectories,
        string? appData,
        Func<string, bool> exists)
    {
        foreach (string candidate in Candidates(configured, pathDirectories, appData))
        {
            if (exists(candidate)) return candidate;
        }
        return null;
    }

    /// <summary>Splits <c>%PATH%</c>, tolerating the empty entries a hand-edited PATH collects.</summary>
    public static IEnumerable<string> SplitPath(string? path) =>
        (path ?? string.Empty)
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(entry => entry.Trim('"'));
}
