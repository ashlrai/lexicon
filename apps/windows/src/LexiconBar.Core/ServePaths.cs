using System.Text.Json;

namespace LexiconBar;

/// <summary>Port and bearer token for the local <c>lexicon serve</c> API.</summary>
public sealed record ServeCredentials(int Port, string Token)
{
    public const int DefaultPort = 41733;

    public Uri BaseUri => new($"http://127.0.0.1:{Port}");

    /// <summary>Null when the file is missing a usable token.</summary>
    public static ServeCredentials? Parse(string json)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return null;
            if (!root.TryGetProperty("token", out JsonElement tokenElement)
                || tokenElement.ValueKind != JsonValueKind.String)
            {
                return null;
            }

            string? token = tokenElement.GetString();
            if (string.IsNullOrEmpty(token)) return null;

            int port = root.TryGetProperty("port", out JsonElement portElement)
                       && portElement.ValueKind == JsonValueKind.Number
                       && portElement.TryGetInt32(out int parsed)
                       && parsed is > 0 and <= 65535
                ? parsed
                : DefaultPort;

            return new ServeCredentials(port, token);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>
/// Where <c>serve.json</c> lives on Windows.
///
/// This is worth spelling out because the obvious guess is wrong. The Node side
/// (<c>src/core/store.ts</c>, <c>resolvePaths</c>) computes its config home as
/// <c>process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')</c> with
/// **no <c>win32</c> branch at all**, and <c>src/serve/config.ts</c> writes
/// <c>serve.json</c> next to the global lexicon. On Windows
/// <c>os.homedir()</c> is <c>%USERPROFILE%</c>, so the real path the CLI writes
/// is:
///
/// <code>%USERPROFILE%\.config\lexicon\serve.json</code>
///
/// — not <c>%APPDATA%\lexicon\serve.json</c>. The <c>%APPDATA%</c> and
/// <c>%LOCALAPPDATA%</c> locations are probed after it anyway, so that if the
/// Node side ever grows a proper Windows branch this app keeps working without
/// a release; and <c>LEXICON_PATH</c> / <c>XDG_CONFIG_HOME</c> are honoured
/// first, exactly as they are there.
/// </summary>
public static class ServePaths
{
    public const string FileName = "serve.json";

    /// <summary>
    /// The paths to try, best first. Pure (takes the environment and home
    /// directory as arguments) so it can be tested off Windows.
    /// </summary>
    public static IReadOnlyList<string> Candidates(IReadOnlyDictionary<string, string?> env, string home)
    {
        List<string> paths = new();

        void Add(string path)
        {
            if (!paths.Contains(path, StringComparer.OrdinalIgnoreCase)) paths.Add(path);
        }

        if (Value(env, "LEXICON_PATH") is string lexiconPath)
        {
            if (DirectoryOf(lexiconPath) is string directory) Add(Path.Combine(directory, FileName));
        }

        if (Value(env, "XDG_CONFIG_HOME") is string xdg) Add(Path.Combine(xdg, "lexicon", FileName));

        // What the CLI actually writes today.
        if (!string.IsNullOrEmpty(home)) Add(Path.Combine(home, ".config", "lexicon", FileName));

        // Forward-compatible probes, in case the Node side grows a win32 branch.
        if (Value(env, "APPDATA") is string appData) Add(Path.Combine(appData, "lexicon", FileName));
        if (Value(env, "LOCALAPPDATA") is string localAppData) Add(Path.Combine(localAppData, "lexicon", FileName));

        return paths;
    }

    /// <summary>The first candidate that exists, or null.</summary>
    public static string? Locate(
        IReadOnlyDictionary<string, string?> env,
        string home,
        Func<string, bool> exists)
    {
        foreach (string candidate in Candidates(env, home))
        {
            if (exists(candidate)) return candidate;
        }
        return null;
    }

    public static IReadOnlyDictionary<string, string?> CurrentEnvironment()
    {
        Dictionary<string, string?> env = new(StringComparer.OrdinalIgnoreCase);
        foreach (string name in new[] { "LEXICON_PATH", "XDG_CONFIG_HOME", "APPDATA", "LOCALAPPDATA" })
        {
            env[name] = Environment.GetEnvironmentVariable(name);
        }
        return env;
    }

    /// <summary>
    /// The directory part of a path, splitting on both separators rather than
    /// on <see cref="Path.DirectorySeparatorChar"/>. <c>LEXICON_PATH</c> is a
    /// user-set environment variable and on Windows it turns up with forward
    /// slashes often enough (anything set from Git Bash, a WSL-flavoured
    /// profile, or copied out of the docs) that
    /// <see cref="Path.GetDirectoryName(string)"/> alone would be wrong on one
    /// of the two. Doing it by hand also means this is the same on the Mac the
    /// tests run on.
    /// </summary>
    internal static string? DirectoryOf(string path)
    {
        int slash = path.LastIndexOfAny(new[] { '\\', '/' });
        if (slash <= 0) return null;
        return path[..slash];
    }

    private static string? Value(IReadOnlyDictionary<string, string?> env, string name) =>
        env.TryGetValue(name, out string? value) && !string.IsNullOrEmpty(value) ? value : null;
}
