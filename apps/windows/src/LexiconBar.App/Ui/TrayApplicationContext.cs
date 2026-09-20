using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using LexiconBar.FixEverywhere;
using Windows.Win32.UI.Accessibility;

namespace LexiconBar.Ui;

/// <summary>
/// The tray icon, its menu, and the wiring between the UI thread and the UI
/// Automation thread. The counterpart of <c>AppDelegate.swift</c>.
/// </summary>
internal sealed class TrayApplicationContext : ApplicationContext
{
    /// <summary>CLSID_CUIAutomation8 — the threading-aware client, Windows 8 and later.</summary>
    private static readonly Guid ClsidCUIAutomation8 = new("e22ad333-b25f-460c-83d0-0581107395c9");

    /// <summary>CLSID_CUIAutomation — the original, as a fallback.</summary>
    private static readonly Guid ClsidCUIAutomation = new("ff48dba4-60ef-4201-aa87-54103eef594e");

    private readonly string _settingsPath;
    private readonly AppSettings _settings;
    private readonly NotifyIcon _tray = new();
    private readonly HotkeyWindow _hotkeys;
    private readonly NormalizeClient _client = new();
    private readonly CorrectionBubbleForm _bubble = new();
    private readonly System.Windows.Forms.Timer _clipboardTimer = new();

    private readonly UiaThread _uia;
    private readonly IUIAutomation _automation;
    private readonly FocusWatcher _watcher;
    private readonly FixEngine _engine;

    private ToolStripMenuItem _fixEverywhereItem = null!;
    private ToolStripMenuItem _fixInAppItem = null!;
    private ToolStripMenuItem _watchClipboardItem = null!;
    private ToolStripMenuItem _bubbleItem = null!;
    private ToolStripMenuItem _undoItem = null!;
    private ToolStripMenuItem _lastCorrectionItem = null!;
    private ToolStripMenuItem _startAtLoginItem = null!;

    /// <summary>
    /// Set while the menu is updating its own checkboxes.
    /// <c>CheckedChanged</c> does not distinguish a user click from a
    /// programmatic assignment, so without this the per-app item toggles the
    /// exclusion every single time the menu is opened, and the start-at-login
    /// item recurses when its handler re-reads the registry.
    /// </summary>
    private bool _suppressMenuEvents;

    private string? _lastClipboardText;
    private FixEngine.Fix? _lastFix;

    internal TrayApplicationContext(string settingsPath)
    {
        _settingsPath = settingsPath;
        _settings = AppSettings.Load(settingsPath);

        _uia = new UiaThread();
        _automation = CreateAutomation(_uia);
        _watcher = new FocusWatcher(_automation, _uia);
        _engine = new FixEngine(
            _uia,
            _watcher,
            _client,
            SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext());

        _engine.OnEvent = OnEngineEvent;
        _bubble.ActionChosen = OnBubbleAction;

        _hotkeys = new HotkeyWindow();
        _hotkeys.UndoPressed = () => _engine.UndoLast();
        _hotkeys.FixClipboardPressed = () => _ = FixClipboardAsync();

        BuildMenu();
        ApplySettings();

        _watcher.Start();
        Log.Info($"serve.json: {_client.ResolvedPath ?? "not found yet"}");
    }

    // ------------------------------------------------------------- start-up

    /// <summary>
    /// Creates the UI Automation client <b>on the UIA thread</b>. COM would
    /// marshal it across apartments otherwise, which for a client this chatty
    /// means a proxy hop on every one of the several calls per poll.
    /// </summary>
    private static IUIAutomation CreateAutomation(UiaThread thread) =>
        thread.Invoke(() =>
        {
            foreach (Guid clsid in new[] { ClsidCUIAutomation8, ClsidCUIAutomation })
            {
                try
                {
                    Type? type = Type.GetTypeFromCLSID(clsid);
                    if (type is null) continue;
                    if (Activator.CreateInstance(type) is IUIAutomation automation) return automation;
                }
                catch (COMException ex)
                {
                    Log.Warn($"CoCreateInstance({clsid:B}) failed: 0x{ex.HResult:X8}");
                }
            }

            throw new COMException("Neither CUIAutomation8 nor CUIAutomation could be created.");
        });

    private void BuildMenu()
    {
        ContextMenuStrip menu = new();

        _fixEverywhereItem = Checkable("Fix everywhere", _settings.FixEverywhere, value =>
        {
            _settings.FixEverywhere = value;
            ApplySettings();
        });

        _fixInAppItem = Checkable("Fix everywhere here", true, _ => ToggleCurrentAppExclusion());

        _watchClipboardItem = Checkable("Watch clipboard", _settings.WatchClipboard, value =>
        {
            _settings.WatchClipboard = value;
            ApplySettings();
        });

        _bubbleItem = Checkable("Show the correction bubble", _settings.ShowBubble, value =>
        {
            _settings.ShowBubble = value;
            ApplySettings();
        });

        _undoItem = new ToolStripMenuItem("Undo last fix\tCtrl+Alt+Z", null, (_, _) => _engine.UndoLast())
        {
            Enabled = false,
        };

        _lastCorrectionItem = new ToolStripMenuItem("Last correction") { Enabled = false };

        _startAtLoginItem = Checkable("Start at login", StartupRegistration.IsEnabled(), value =>
        {
            if (StartupRegistration.SetEnabled(value)) return;
            _suppressMenuEvents = true;
            _startAtLoginItem.Checked = StartupRegistration.IsEnabled();
            _suppressMenuEvents = false;
            Notify("LexiconBar", "Windows would not let me change the startup setting.", ToolTipIcon.Warning);
        });

        menu.Items.AddRange(new ToolStripItem[]
        {
            _fixEverywhereItem,
            _fixInAppItem,
            new ToolStripSeparator(),
            new ToolStripMenuItem("Fix clipboard now\tCtrl+Alt+V", null, (_, _) => _ = FixClipboardAsync()),
            _watchClipboardItem,
            new ToolStripSeparator(),
            _lastCorrectionItem,
            _undoItem,
            _bubbleItem,
            new ToolStripSeparator(),
            new ToolStripMenuItem("Open lexicon file", null, (_, _) => OpenLexiconFile()),
            new ToolStripMenuItem("Run doctor", null, (_, _) => _ = RunDoctorAsync()),
            new ToolStripSeparator(),
            _startAtLoginItem,
            new ToolStripMenuItem("Preferences...", null, (_, _) => ShowPreferences()),
            new ToolStripMenuItem("Quit", null, (_, _) => Quit()),
        });

        menu.Opening += (_, _) => RefreshDynamicItems();

        _tray.Icon = TrayIconFactory.Waveform(TrayIconFactory.State.Idle);
        _tray.Text = "LexiconBar";
        _tray.ContextMenuStrip = menu;
        _tray.Visible = true;

        _clipboardTimer.Interval = 500;
        _clipboardTimer.Tick += (_, _) => PollClipboard();
    }

    private ToolStripMenuItem Checkable(string text, bool initial, Action<bool> onToggle)
    {
        ToolStripMenuItem item = new(text) { Checked = initial, CheckOnClick = true };
        item.CheckedChanged += (_, _) =>
        {
            if (_suppressMenuEvents) return;
            onToggle(item.Checked);
        };
        return item;
    }

    private void ApplySettings()
    {
        _engine.Update(new FixEngine.Config
        {
            Enabled = _settings.FixEverywhere,
            Detector = _settings.DetectorConfig(),
            Exclusions = new AppExclusions(_settings.Exclusions),
        });

        // The watcher gets its own copy of the list, not a shared instance:
        // AppExclusions is mutable, and the menu edits one while the UIA thread
        // may be matching against the other.
        _watcher.Configure(_settings.PollMs, _settings.MaxFieldLength, new AppExclusions(_settings.Exclusions));
        _clipboardTimer.Enabled = _settings.WatchClipboard;

        try
        {
            _settings.Save(_settingsPath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            Log.Warn($"could not save settings: {ex.Message}");
        }
    }

    private void RefreshDynamicItems()
    {
        _suppressMenuEvents = true;
        try
        {
            RefreshDynamicItemsCore();
        }
        finally
        {
            _suppressMenuEvents = false;
        }
    }

    private void RefreshDynamicItemsCore()
    {
        _startAtLoginItem.Checked = StartupRegistration.IsEnabled();
        string process = _watcher.FrontmostProcessName;
        if (process.Length == 0)
        {
            _fixInAppItem.Visible = false;
        }
        else
        {
            _fixInAppItem.Visible = true;
            _fixInAppItem.Text = $"Fix everywhere in {process}";
            _fixInAppItem.Checked = !new AppExclusions(_settings.Exclusions).IsExcluded(process);
        }

        _lastCorrectionItem.DropDownItems.Clear();
        if (_lastFix is FixEngine.Fix fix && fix.Replacements.Count > 0)
        {
            _lastCorrectionItem.Enabled = true;
            foreach (FixReplacement replacement in fix.Replacements)
            {
                string label = $"{replacement.Original} → {replacement.Replacement}";
                _lastCorrectionItem.DropDownItems.Add(new ToolStripMenuItem(label, null, (_, _) =>
                {
                    TrySetClipboard(replacement.Replacement);
                }));
            }

            _lastCorrectionItem.DropDownItems.Add(new ToolStripSeparator());
            _lastCorrectionItem.DropDownItems.Add(new ToolStripMenuItem(
                $"in {fix.AppName} via {fix.Strategy}, {fix.ElapsedMs} ms") { Enabled = false });
        }
        else
        {
            _lastCorrectionItem.Enabled = false;
        }
    }

    private void ToggleCurrentAppExclusion()
    {
        string process = _watcher.FrontmostProcessName;
        if (process.Length == 0) return;

        AppExclusions exclusions = new(_settings.Exclusions);
        if (exclusions.IsExcluded(process))
        {
            exclusions.Include(process);
        }
        else
        {
            exclusions.Exclude(process);
        }

        _settings.Exclusions = exclusions.ProcessNames;
        ApplySettings();
    }

    // -------------------------------------------------------------- events

    private void OnEngineEvent(FixEngine.Event @event)
    {
        switch (@event)
        {
            case FixEngine.Event.Fixed fixedEvent:
                _lastFix = fixedEvent.Fix;
                ShowCorrection(fixedEvent.Fix);
                break;

            case FixEngine.Event.Undone undone:
                Notify("Undone", $"Put the dictated text back in {undone.AppName}.", ToolTipIcon.None);
                break;

            case FixEngine.Event.UndoAvailable available:
                _undoItem.Enabled = available.Available;
                break;

            case FixEngine.Event.Skipped skipped:
                Log.Info(skipped.Why);
                break;

            case FixEngine.Event.Failed failed:
                _tray.Icon = TrayIconFactory.Waveform(TrayIconFactory.State.Problem);
                Notify("LexiconBar", failed.Why, ToolTipIcon.Warning);
                break;
        }
    }

    private void ShowCorrection(FixEngine.Fix fix)
    {
        _tray.Icon = TrayIconFactory.Waveform(TrayIconFactory.State.Idle);
        BubbleContent? content = CorrectionBubble.Content(fix.Replacements);
        if (content is null) return;

        if (_settings.ShowBubble)
        {
            _bubble.Present(content, fix.Caret, _settings.BubbleSeconds);
        }
        else
        {
            Notify(content.Title, string.Join(", ", content.Lines.Select(line => line.Label)), ToolTipIcon.None);
        }
    }

    private void OnBubbleAction(BubbleAction action, BubbleLine target)
    {
        switch (action)
        {
            case BubbleAction.Undo:
                _engine.UndoLast();
                break;

            case BubbleAction.Never:
                _ = Task.Run(async () =>
                {
                    await _client.NeverAsync(target.Canonical, target.Original).ConfigureAwait(false);
                });
                _engine.UndoLast();
                break;

            case BubbleAction.Add:
                _ = Task.Run(async () =>
                {
                    await _client.LearnAsync(target.Original, target.Canonical).ConfigureAwait(false);
                });
                break;
        }
    }

    // ----------------------------------------------------------- clipboard

    private void PollClipboard()
    {
        string? text = TryGetClipboard();
        if (text is null || text == _lastClipboardText) return;
        _lastClipboardText = text;
        _ = FixClipboardAsync(text);
    }

    private async Task FixClipboardAsync(string? text = null)
    {
        text ??= TryGetClipboard();
        if (string.IsNullOrWhiteSpace(text))
        {
            Notify("LexiconBar", "The clipboard has no text on it.", ToolTipIcon.None);
            return;
        }

        if (text.Length > _settings.MaxFieldLength)
        {
            Notify("LexiconBar", "That is longer than the maximum field length; left alone.", ToolTipIcon.None);
            return;
        }

        NormalizeClient.Result result = await _client.NormalizeAsync(text).ConfigureAwait(true);
        if (result.Response is not NormalizeResponse response)
        {
            Notify("LexiconBar", result.Failure?.Description ?? "The local API did not answer.", ToolTipIcon.Warning);
            return;
        }

        if (!response.Changed || response.Output == text) return;

        _lastClipboardText = response.Output;
        if (!TrySetClipboard(response.Output))
        {
            Notify("LexiconBar", "Another app is holding the clipboard; nothing was changed.", ToolTipIcon.Warning);
            return;
        }

        BubbleContent? content = CorrectionBubble.Content(response.Replacements);
        Notify(content?.Title ?? response.Summary,
            content is null ? "Clipboard corrected." : string.Join(", ", content.Lines.Select(line => line.Label)),
            ToolTipIcon.None);
    }

    private static string? TryGetClipboard()
    {
        // The clipboard is a shared, lockable resource; another app can be
        // holding it at the exact moment the poll fires.
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                return Clipboard.ContainsText() ? Clipboard.GetText() : null;
            }
            catch (ExternalException)
            {
                Thread.Sleep(30);
            }
        }

        return null;
    }

    private static bool TrySetClipboard(string text)
    {
        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                Clipboard.SetText(text);
                return true;
            }
            catch (ExternalException)
            {
                Thread.Sleep(30);
            }
        }

        return false;
    }

    // -------------------------------------------------------------- the CLI

    private string? LocateCli() => CliLocator.Locate(
        _settings.CliPath,
        CliLocator.SplitPath(Environment.GetEnvironmentVariable("PATH")),
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        File.Exists);

    private void OpenLexiconFile()
    {
        if (LocateCli() is not string cli)
        {
            Notify("LexiconBar", "Could not find the lexicon CLI. Set its path in Preferences.", ToolTipIcon.Warning);
            return;
        }

        string? path = RunCli(cli, "path")?.Trim();
        if (string.IsNullOrEmpty(path) || !File.Exists(path))
        {
            Notify("LexiconBar", "`lexicon path` did not name a file that exists.", ToolTipIcon.Warning);
            return;
        }

        try
        {
            Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException)
        {
            Notify("LexiconBar", $"Could not open {path}: {ex.Message}", ToolTipIcon.Warning);
        }
    }

    private async Task RunDoctorAsync()
    {
        int? terms = await _client.HealthAsync().ConfigureAwait(true);
        System.Text.StringBuilder report = new();
        report.AppendLine("LexiconBar (Windows)");
        report.AppendLine($"  version        {typeof(TrayApplicationContext).Assembly.GetName().Version}");
        report.AppendLine($"  executable     {Environment.ProcessPath}");
        report.AppendLine($"  settings       {_settingsPath}");
        report.AppendLine($"  serve.json     {_client.ResolvedPath ?? "NOT FOUND"}");
        report.AppendLine($"  local API      {(terms is int count ? $"up, {count} terms" : "not reachable")}");
        report.AppendLine($"  fix everywhere {(_settings.FixEverywhere ? "on" : "off")}");
        report.AppendLine($"  start at login {(StartupRegistration.IsEnabled() ? "on" : "off")}");
        report.AppendLine();

        if (LocateCli() is string cli)
        {
            report.AppendLine($"lexicon CLI: {cli}");
            report.AppendLine();
            report.AppendLine(RunCli(cli, "doctor") ?? "(no output)");
        }
        else
        {
            report.AppendLine("lexicon CLI: not found on PATH. Set its path in Preferences.");
        }

        report.AppendLine();
        report.AppendLine("--- recent log ---");
        report.AppendLine(Log.Recent());

        new TextWindow("LexiconBar doctor", report.ToString()).Show();
    }

    private static string? RunCli(string executable, string arguments)
    {
        try
        {
            ProcessStartInfo info = new(executable, arguments)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            };

            using Process? process = Process.Start(info);
            if (process is null) return null;

            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            if (!process.WaitForExit(10_000))
            {
                process.Kill(entireProcessTree: true);
                return "(timed out after 10s)";
            }

            return output.Length > 0 ? output : error;
        }
        catch (Exception ex) when (ex is Win32Exception or InvalidOperationException or IOException)
        {
            return $"(could not run {executable}: {ex.Message})";
        }
    }

    // --------------------------------------------------------------- chrome

    private void ShowPreferences()
    {
        using PreferencesForm form = new(_settings);
        if (form.ShowDialog() != DialogResult.OK) return;
        ApplySettings();
    }

    private void Notify(string title, string body, ToolTipIcon icon)
    {
        _tray.BalloonTipTitle = title;
        _tray.BalloonTipText = body.Length > 240 ? body[..240] : body;
        _tray.BalloonTipIcon = icon;
        _tray.ShowBalloonTip(4000);
    }

    private void Quit()
    {
        _tray.Visible = false;
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _clipboardTimer.Dispose();
            _watcher.Stop();
            _hotkeys.Dispose();
            _bubble.Dispose();
            _tray.Dispose();
            _client.Dispose();
            _uia.Dispose();
        }

        base.Dispose(disposing);
    }
}
