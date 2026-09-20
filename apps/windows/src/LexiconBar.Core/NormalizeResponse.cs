using System.Text.Json;

namespace LexiconBar;

/// <summary>One replacement the API reported, positioned in the burst text (UTF-16).</summary>
public sealed record FixReplacement(
    int Start,
    int End,
    string Original,
    string Replacement,
    string? Reason = null,
    double? Confidence = null);

/// <summary>The parsed body of <c>POST /normalize</c>.</summary>
public sealed record NormalizeResponse(
    string Input,
    string Output,
    bool Changed,
    IReadOnlyList<FixReplacement> Replacements,
    string Summary)
{
    /// <summary>
    /// Tolerant on purpose: the server is a different codebase on a different
    /// release cadence, and a field it stops sending must not turn into an
    /// exception in the middle of a rewrite. Anything unparseable returns null
    /// and the burst is left alone.
    /// </summary>
    public static NormalizeResponse? Parse(string json)
    {
        JsonElement root;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            root = document.RootElement.Clone();
        }
        catch (JsonException)
        {
            return null;
        }

        if (root.ValueKind != JsonValueKind.Object) return null;
        if (!root.TryGetProperty("output", out JsonElement outputElement)
            || outputElement.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        string output = outputElement.GetString()!;
        string input = root.TryGetProperty("input", out JsonElement inputElement)
                       && inputElement.ValueKind == JsonValueKind.String
            ? inputElement.GetString()!
            : string.Empty;

        List<FixReplacement> replacements = new();
        if (root.TryGetProperty("replacements", out JsonElement list) && list.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in list.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                if (String(item, "original") is not string original) continue;
                string replacement = String(item, "replacement") ?? String(item, "canonical") ?? original;
                replacements.Add(new FixReplacement(
                    Start: (int)(Number(item, "start") ?? 0),
                    End: (int)(Number(item, "end") ?? 0),
                    Original: original,
                    Replacement: replacement,
                    Reason: String(item, "reason"),
                    Confidence: Number(item, "confidence")));
            }
        }

        bool changed = root.TryGetProperty("changed", out JsonElement changedElement)
                       && changedElement.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? changedElement.GetBoolean()
            : output != input;

        string summary = String(root, "summary") ?? DefaultSummary(replacements.Count);
        return new NormalizeResponse(input, output, changed, replacements, summary);
    }

    public static string DefaultSummary(int count) => count == 1 ? "Fixed 1 word" : $"Fixed {count} words";

    private static string? String(JsonElement element, string name) =>
        element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;

    private static double? Number(JsonElement element, string name) =>
        element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.Number
        && value.TryGetDouble(out double number)
            ? number
            : null;
}
