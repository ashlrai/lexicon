using Microsoft.Win32;

namespace LexiconBar;

/// <summary>
/// "Start at login", through <c>HKCU\...\CurrentVersion\Run</c>.
///
/// The per-user Run key rather than a scheduled task or the Startup folder:
/// it needs no elevation, it is where Windows' own Startup apps UI shows it, and
/// the user can turn it off there without the app agreeing. A scheduled task
/// would survive that toggle, which is the sort of thing tray apps get
/// justifiably hated for.
/// </summary>
public static class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "LexiconBar";

    public static bool IsEnabled()
    {
        try
        {
            using RegistryKey? key = Registry.CurrentUser.OpenSubKey(RunKey, writable: false);
            return key?.GetValue(ValueName) is string value && value.Length > 0;
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return false;
        }
    }

    /// <summary>Returns false when the registry refused; the caller should not flip its checkbox.</summary>
    public static bool SetEnabled(bool enabled, string? executablePath = null)
    {
        try
        {
            using RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
            if (!enabled)
            {
                key.DeleteValue(ValueName, throwOnMissingValue: false);
                return true;
            }

            string path = executablePath ?? Environment.ProcessPath ?? string.Empty;
            if (path.Length == 0) return false;

            // Quoted: the published exe often sits under a path with spaces.
            key.SetValue(ValueName, $"\"{path}\"", RegistryValueKind.String);
            return true;
        }
        catch (Exception ex) when (ex is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            Log.Warn($"could not update the Run key: {ex.Message}");
            return false;
        }
    }
}
