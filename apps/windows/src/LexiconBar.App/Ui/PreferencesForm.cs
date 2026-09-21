using System.Drawing;
using System.Windows.Forms;

namespace LexiconBar.Ui;

/// <summary>
/// Preferences. Deliberately a plain form built in code rather than with the
/// designer, so the project needs no Visual Studio and no .resx.
/// </summary>
internal sealed class PreferencesForm : Form
{
    private readonly AppSettings _settings;
    private readonly NumericUpDown _settle = new();
    private readonly NumericUpDown _minWords = new();
    private readonly NumericUpDown _runQuiet = new();
    private readonly NumericUpDown _maxField = new();
    private readonly NumericUpDown _poll = new();
    private readonly NumericUpDown _bubbleSeconds = new();
    private readonly TextBox _cliPath = new();
    private readonly TextBox _exclusions = new();
    private readonly Label _exclusionsHint;

    /// <summary>The hint under the exclusions box while the list excludes something.</summary>
    private const string ExclusionsHint =
        "Executable names without .exe. A trailing * matches a prefix (keepass*).";

    internal PreferencesForm(AppSettings settings)
    {
        _settings = settings;

        Text = "LexiconBar Preferences";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(560, 520);
        Icon = TrayIconFactory.Waveform(TrayIconFactory.State.Idle);

        TableLayoutPanel layout = new()
        {
            Dock = DockStyle.Fill,
            ColumnCount = 2,
            Padding = new Padding(16),
            AutoSize = false,
        };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 220));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        AddHeader(layout, "Fix everywhere");
        AddNumeric(layout, "Settle delay (ms)", _settle, 100, 5000, settings.SettleMs,
            "How long the field must be quiet before a single insertion is judged.");
        AddNumeric(layout, "Minimum words", _minWords, 1, 20, settings.MinWords,
            "Shorter insertions are only corrected if they arrive in one chunk.");
        AddNumeric(layout, "Streamed run quiet (ms)", _runQuiet, 300, 6000, settings.RunQuietMs,
            "Silence that ends word-by-word dictation. Longer than a pause between words.");
        AddNumeric(layout, "Maximum field length", _maxField, 500, 200_000, settings.MaxFieldLength,
            "Longer fields are ignored entirely.");
        AddNumeric(layout, "Poll interval (ms)", _poll, 60, 2000, settings.PollMs,
            "The safety net for apps that do not raise UIA text-changed events.");

        AddHeader(layout, "Correction bubble");
        AddNumeric(layout, "Seconds on screen", _bubbleSeconds, 0, 30, (int)settings.BubbleSeconds,
            "0 keeps it up until you dismiss it.");

        AddHeader(layout, "Lexicon CLI");
        _cliPath.Text = settings.CliPath;
        _cliPath.Width = 300;
        AddRow(layout, "Path to lexicon", _cliPath, "Leave blank to search PATH. Used only for Open lexicon file and Run doctor.");

        AddHeader(layout, "Excluded processes");
        _exclusions.Multiline = true;
        _exclusions.ScrollBars = ScrollBars.Vertical;
        _exclusions.Height = 110;
        _exclusions.Width = 300;
        _exclusions.Text = string.Join(Environment.NewLine, settings.Exclusions);
        _exclusionsHint = AddRow(layout, "One per line", _exclusions, ExclusionsHint);
        _exclusions.TextChanged += (_, _) => RefreshExclusionsHint();
        RefreshExclusionsHint();

        FlowLayoutPanel buttons = new()
        {
            FlowDirection = FlowDirection.RightToLeft,
            Dock = DockStyle.Bottom,
            Height = 44,
            Padding = new Padding(16, 8, 16, 8),
        };

        Button ok = new() { Text = "Save", DialogResult = DialogResult.OK, AutoSize = true };
        Button cancel = new() { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true };
        Button restore = new() { Text = "Restore defaults", AutoSize = true };
        restore.Click += (_, _) => RestoreDefaults();

        buttons.Controls.Add(ok);
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(restore);

        AcceptButton = ok;
        CancelButton = cancel;

        Controls.Add(new Panel { Dock = DockStyle.Fill, AutoScroll = true, Controls = { layout } });
        Controls.Add(buttons);

        FormClosing += (_, e) =>
        {
            if (DialogResult != DialogResult.OK || e.Cancel) return;
            if (!ConfirmEmptyExclusions())
            {
                // Keep the window open with the text still in it, so answering
                // "no" costs nothing.
                e.Cancel = true;
                DialogResult = DialogResult.None;
                return;
            }

            Commit();
        };
    }

    /// <summary>
    /// The exclusion entries as typed, blank lines dropped. The same list
    /// <see cref="Commit"/> saves, so what the hint judges and what gets
    /// written are never two different things.
    /// </summary>
    private List<string> Entered() => _exclusions.Text
        .Split('\n')
        .Select(line => line.Trim())
        .Where(line => line.Length > 0)
        .ToList();

    /// <summary>
    /// Says when the list excludes nothing, instead of letting a cleared box
    /// look like any other edit. An empty list is a legitimate choice and is
    /// saved as one; it is also the only setting in this window that can put
    /// dictation into a password manager, so it does not pass quietly.
    /// </summary>
    private void RefreshExclusionsHint()
    {
        bool empty = new AppExclusions(Entered()).IsEmpty;
        _exclusionsHint.Text = empty ? AppExclusions.EmptyWarning : ExclusionsHint;
        _exclusionsHint.ForeColor = empty ? Color.FromArgb(0xB0, 0x3A, 0x00) : SystemColors.GrayText;
    }

    /// <summary>
    /// Asks before saving a list that excludes nothing, and only when it was
    /// not already empty. The box is one Ctrl+A away from losing every default,
    /// and those defaults are what keep Fix everywhere out of terminals, out of
    /// Windows' own sign-in prompts and out of password managers. A user who
    /// has already chosen an empty list is not asked again.
    /// </summary>
    private bool ConfirmEmptyExclusions()
    {
        if (!new AppExclusions(Entered()).IsEmpty) return true;
        if (new AppExclusions(_settings.Exclusions).IsEmpty) return true;

        return MessageBox.Show(
            this,
            $"{AppExclusions.EmptyWarning}\n\nSave the empty list anyway?",
            "No excluded processes",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Warning,
            MessageBoxDefaultButton.Button2) == DialogResult.Yes;
    }

    private void RestoreDefaults()
    {
        AppSettings defaults = new();
        _settle.Value = defaults.SettleMs;
        _minWords.Value = defaults.MinWords;
        _runQuiet.Value = defaults.RunQuietMs;
        _maxField.Value = defaults.MaxFieldLength;
        _poll.Value = defaults.PollMs;
        _bubbleSeconds.Value = (decimal)defaults.BubbleSeconds;
        _exclusions.Text = string.Join(Environment.NewLine, defaults.Exclusions);
    }

    private void Commit()
    {
        _settings.SettleMs = (int)_settle.Value;
        _settings.MinWords = (int)_minWords.Value;
        _settings.RunQuietMs = (int)_runQuiet.Value;
        _settings.MaxFieldLength = (int)_maxField.Value;
        _settings.PollMs = (int)_poll.Value;
        _settings.BubbleSeconds = (double)_bubbleSeconds.Value;
        _settings.CliPath = _cliPath.Text.Trim();
        _settings.Exclusions = Entered();
    }

    private static void AddHeader(TableLayoutPanel layout, string text)
    {
        Label header = new()
        {
            Text = text,
            AutoSize = true,
            Font = new Font(SystemFonts.DefaultFont, FontStyle.Bold),
            Margin = new Padding(0, 14, 0, 4),
        };
        layout.Controls.Add(header);
        layout.SetColumnSpan(header, 2);
    }

    private static void AddNumeric(
        TableLayoutPanel layout,
        string label,
        NumericUpDown control,
        int minimum,
        int maximum,
        int value,
        string hint)
    {
        control.Minimum = minimum;
        control.Maximum = maximum;
        control.Value = Math.Clamp(value, minimum, maximum);
        control.Width = 100;
        AddRow(layout, label, control, hint);
    }

    /// <summary>Adds a labelled row and hands back its grey hint label, which some rows rewrite.</summary>
    private static Label AddRow(TableLayoutPanel layout, string label, Control control, string hint)
    {
        layout.Controls.Add(new Label
        {
            Text = label,
            AutoSize = true,
            Margin = new Padding(0, 6, 8, 0),
        });

        FlowLayoutPanel cell = new()
        {
            FlowDirection = FlowDirection.TopDown,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            WrapContents = false,
            Margin = new Padding(0, 2, 0, 6),
        };
        Label hintLabel = new()
        {
            Text = hint,
            AutoSize = true,
            MaximumSize = new Size(300, 0),
            ForeColor = SystemColors.GrayText,
            Margin = new Padding(0, 2, 0, 0),
        };

        cell.Controls.Add(control);
        cell.Controls.Add(hintLabel);

        layout.Controls.Add(cell);
        return hintLabel;
    }
}

/// <summary>A scrollable read-only window, for <c>lexicon doctor</c> output and the log.</summary>
internal sealed class TextWindow : Form
{
    internal TextWindow(string title, string body)
    {
        Text = title;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(760, 520);
        Icon = TrayIconFactory.Waveform(TrayIconFactory.State.Idle);

        TextBox text = new()
        {
            Dock = DockStyle.Fill,
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Both,
            WordWrap = false,
            Font = new Font(FontFamily.GenericMonospace, 9f),
            Text = body,
        };

        Controls.Add(text);
    }
}
