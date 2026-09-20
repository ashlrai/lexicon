using System.Diagnostics;
using System.Text;

namespace LexiconBar;

/// <summary>
/// A ring buffer in memory plus an optional line-per-event file, so that when
/// the cofounder says "it did not correct that sentence" there is an answer.
/// The Mac app's equivalent goes to the unified log, which Windows has no
/// direct analogue for.
///
/// **Nothing that came out of a text field is ever logged**, only decisions
/// about it. "skip in chrome: too short (1 words, 6 units)" is fine; the six
/// units are not. The whole point of the secret-field heuristic is undone if
/// the refused text ends up in a log file.
/// </summary>
public static class Log
{
    private const int Capacity = 500;
    private static readonly object Gate = new();
    private static readonly Queue<string> Lines = new();
    private static string? _filePath;

    /// <summary>Turns on the file sink. Errors are swallowed: logging must never break the app.</summary>
    public static void ToFile(string path)
    {
        lock (Gate)
        {
            try
            {
                string? directory = Path.GetDirectoryName(path);
                if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
                _filePath = path;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _filePath = null;
            }
        }
    }

    public static void Info(string message) => Write("info", message);

    public static void Warn(string message) => Write("warn", message);

    public static void Error(string message) => Write("error", message);

    private static void Write(string level, string message)
    {
        string line = $"{DateTime.Now:HH:mm:ss.fff} {level} {message}";
        Debug.WriteLine(line);
        lock (Gate)
        {
            Lines.Enqueue(line);
            while (Lines.Count > Capacity) Lines.Dequeue();
            if (_filePath is null) return;
            try
            {
                File.AppendAllText(_filePath, line + Environment.NewLine, Encoding.UTF8);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _filePath = null;
            }
        }
    }

    /// <summary>The recent lines, oldest first, for the "Run doctor" window.</summary>
    public static string Recent()
    {
        lock (Gate)
        {
            return string.Join(Environment.NewLine, Lines);
        }
    }
}
