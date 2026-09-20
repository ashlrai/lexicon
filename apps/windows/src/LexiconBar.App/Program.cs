using System.Runtime.InteropServices;
using System.Windows.Forms;
using LexiconBar.Ui;

namespace LexiconBar;

internal static class Program
{
    private const string MutexName = "Local\\ai.ashlr.lexiconbar";

    [STAThread]
    private static void Main(string[] args)
    {
        // One tray icon, one focus watcher. A second copy would double every
        // API call and the two would race to rewrite the same field.
        using Mutex mutex = new(initiallyOwned: true, MutexName, out bool created);
        if (!created)
        {
            MessageBox.Show(
                "LexiconBar is already running. Look for the waveform icon in the notification area.",
                "LexiconBar",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);

        string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        Log.ToFile(Path.Combine(appData, "LexiconBar", "lexiconbar.log"));
        Log.Info($"LexiconBar starting (args: {string.Join(' ', args)})");

        Application.ThreadException += (_, e) => Log.Error($"UI thread exception: {e.Exception}");
        AppDomain.CurrentDomain.UnhandledException += (_, e) => Log.Error($"unhandled: {e.ExceptionObject}");

        try
        {
            using TrayApplicationContext context = new(AppSettings.DefaultPath(appData));
            Application.Run(context);
        }
        catch (COMException ex)
        {
            Log.Error($"UI Automation unavailable: {ex}");
            MessageBox.Show(
                $"LexiconBar could not start UI Automation:\n\n{ex.Message}\n\n"
                + "Fix everywhere needs the UIAutomationCore component, which ships with Windows. "
                + "If this machine has had accessibility features removed, that is the first thing to check.",
                "LexiconBar",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
        }
    }
}
