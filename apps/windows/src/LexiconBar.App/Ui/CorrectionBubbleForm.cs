using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace LexiconBar.Ui;

/// <summary>
/// The small panel that appears near the caret after a correction, the way
/// Grammarly does it: what changed, and a way to take it back.
///
/// The hard requirement is that it must never take keyboard focus. The user is
/// mid-sentence; a window that steals focus would swallow the next word and,
/// worse, would move focus away from the field the undo applies to. On macOS
/// that is an <c>NSPanel</c> with <c>canBecomeKey</c> forced false. The Windows
/// equivalent is three separate things that all have to agree:
///
/// <list type="bullet">
/// <item><c>WS_EX_NOACTIVATE</c> so clicking it does not activate it;</item>
/// <item><see cref="ShowWithoutActivation"/> so showing it does not either;</item>
/// <item>answering <c>WM_MOUSEACTIVATE</c> with <c>MA_NOACTIVATE</c>, which is
///   what actually lets the buttons receive a click while focus stays in the
///   text field. Without this one the first click is eaten activating the
///   window and Undo needs two clicks.</item>
/// </list>
///
/// <c>WS_EX_TOOLWINDOW</c> keeps it out of Alt+Tab.
///
/// UNVERIFIED on real Windows: the no-activate behaviour above is the part most
/// likely to need adjustment on first contact.
/// </summary>
internal sealed class CorrectionBubbleForm : Form
{
    private const int WS_EX_NOACTIVATE = 0x08000000;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int WS_EX_TOPMOST = 0x00000008;
    private const int WM_MOUSEACTIVATE = 0x0021;
    private const int MA_NOACTIVATE = 3;

    private readonly System.Windows.Forms.Timer _dismissTimer = new();
    private readonly FlowLayoutPanel _lines = new();
    private readonly FlowLayoutPanel _buttons = new();
    private readonly Label _title = new();

    private BubbleContent? _content;
    private double _seconds = 4;

    internal Action<BubbleAction, BubbleLine>? ActionChosen { get; set; }

    internal CorrectionBubbleForm()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.FromArgb(32, 32, 34);
        ForeColor = Color.White;
        Padding = new Padding(12, 10, 12, 10);
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Opacity = 0;

        _title.AutoSize = true;
        _title.Font = new Font(Font.FontFamily, 9f, FontStyle.Bold);
        _title.ForeColor = Color.FromArgb(235, 235, 240);
        _title.Margin = new Padding(0, 0, 0, 6);

        _lines.FlowDirection = FlowDirection.TopDown;
        _lines.AutoSize = true;
        _lines.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        _lines.WrapContents = false;
        _lines.Margin = new Padding(0);

        _buttons.FlowDirection = FlowDirection.LeftToRight;
        _buttons.AutoSize = true;
        _buttons.AutoSizeMode = AutoSizeMode.GrowAndShrink;
        _buttons.WrapContents = false;
        _buttons.Margin = new Padding(0, 8, 0, 0);

        TableLayoutPanel layout = new()
        {
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            ColumnCount = 1,
            RowCount = 3,
            Dock = DockStyle.Fill,
            Margin = new Padding(0),
        };
        layout.Controls.Add(_title, 0, 0);
        layout.Controls.Add(_lines, 0, 1);
        layout.Controls.Add(_buttons, 0, 2);
        Controls.Add(layout);

        _dismissTimer.Tick += (_, _) => Hide();

        // Hovering pauses the countdown so the bubble cannot vanish on the way
        // to the Undo button; leaving restarts it.
        MouseEnter += (_, _) => _dismissTimer.Stop();
        MouseLeave += (_, _) => RestartCountdown();
        foreach (Control control in new Control[] { layout, _title, _lines, _buttons })
        {
            control.MouseEnter += (_, _) => _dismissTimer.Stop();
            control.MouseLeave += (_, _) => RestartCountdown();
        }
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            CreateParams parameters = base.CreateParams;
            parameters.ExStyle |= WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TOPMOST;
            return parameters;
        }
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WM_MOUSEACTIVATE)
        {
            // Take the click, do not take focus.
            message.Result = MA_NOACTIVATE;
            return;
        }

        base.WndProc(ref message);
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e);
        using GraphicsPath path = RoundedRectangle(new Rectangle(0, 0, Width - 1, Height - 1), 8);
        using Pen border = new(Color.FromArgb(70, 70, 76));
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        e.Graphics.DrawPath(border, path);
    }

    /// <summary>
    /// The rounded corners. This belongs in OnResize rather than OnPaint:
    /// `Control.Region`'s setter does not dispose what was there before, so
    /// assigning it on every paint leaks a GDI region several times a second
    /// for as long as the bubble is on screen.
    /// </summary>
    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (Width <= 0 || Height <= 0) return;

        using GraphicsPath path = RoundedRectangle(new Rectangle(0, 0, Width - 1, Height - 1), 8);
        Region? previous = Region;
        Region = new Region(path);
        previous?.Dispose();
    }

    /// <summary>
    /// Shows <paramref name="content"/> at <paramref name="caret"/>. Replaces
    /// whatever is on screen rather than stacking a second panel: there is only
    /// ever one bubble.
    /// </summary>
    internal void Present(BubbleContent content, Rectangle? caret, double seconds)
    {
        _content = content;
        _seconds = seconds;
        _title.Text = content.Title;
        AccessibleName = content.AccessibilityLabel;

        _lines.Controls.Clear();
        foreach (BubbleLine line in content.Lines) _lines.Controls.Add(LineControl(line));
        if (content.Overflow is string overflow)
        {
            _lines.Controls.Add(new Label
            {
                AutoSize = true,
                Text = overflow,
                ForeColor = Color.FromArgb(150, 150, 158),
                Margin = new Padding(0, 2, 0, 0),
            });
        }

        _buttons.Controls.Clear();
        foreach (BubbleAction action in content.Actions) _buttons.Controls.Add(ActionButton(action, content.Target));

        // Size is only final once the layout has run.
        PerformLayout();
        Size preferred = PreferredSize;
        Size = preferred;

        Rectangle anchor = caret ?? new Rectangle(Cursor.Position, new Size(1, 1));
        List<Rectangle> screens = Screen.AllScreens.Select(screen => screen.WorkingArea).ToList();
        Rectangle work = BubblePlacement.ScreenContaining(new Point(anchor.Left, anchor.Top), screens)
                         ?? Screen.PrimaryScreen?.WorkingArea
                         ?? new Rectangle(0, 0, 1920, 1080);

        Location = BubblePlacement.Origin(anchor, work, preferred);

        Opacity = 0;
        Show();
        FadeIn();
        RestartCountdown();
    }

    private void FadeIn()
    {
        System.Windows.Forms.Timer fade = new() { Interval = 15 };
        fade.Tick += (_, _) =>
        {
            Opacity = Math.Min(1, Opacity + 0.125);
            if (Opacity < 1) return;
            fade.Stop();
            fade.Dispose();
        };
        fade.Start();
    }

    private void RestartCountdown()
    {
        _dismissTimer.Stop();
        if (_seconds <= 0) return;
        _dismissTimer.Interval = Math.Max(500, (int)(_seconds * 1000));
        _dismissTimer.Start();
    }

    private Control LineControl(BubbleLine line)
    {
        FlowLayoutPanel row = new()
        {
            FlowDirection = FlowDirection.LeftToRight,
            AutoSize = true,
            AutoSizeMode = AutoSizeMode.GrowAndShrink,
            WrapContents = false,
            Margin = new Padding(0, 1, 0, 1),
        };

        row.Controls.Add(new Label
        {
            AutoSize = true,
            Text = line.Original,
            ForeColor = Color.FromArgb(145, 145, 152),
            Font = new Font(Font, FontStyle.Strikeout),
            Margin = new Padding(0, 0, 6, 0),
        });

        row.Controls.Add(new Label
        {
            AutoSize = true,
            Text = "→",
            ForeColor = Color.FromArgb(120, 120, 128),
            Margin = new Padding(0, 0, 6, 0),
        });

        row.Controls.Add(new Label
        {
            AutoSize = true,
            Text = line.Canonical,
            ForeColor = Color.White,
            Font = new Font(Font, FontStyle.Bold),
            Margin = new Padding(0),
        });

        return row;
    }

    private Control ActionButton(BubbleAction action, BubbleLine target)
    {
        Button button = new()
        {
            AutoSize = true,
            Text = action switch
            {
                BubbleAction.Undo => "Undo",
                BubbleAction.Never => "Never",
                _ => "Add",
            },
            FlatStyle = FlatStyle.Flat,
            BackColor = Color.FromArgb(52, 52, 56),
            ForeColor = Color.White,
            Margin = new Padding(0, 0, 6, 0),
            TabStop = false,
        };
        button.FlatAppearance.BorderColor = Color.FromArgb(78, 78, 84);

        button.Click += (_, _) =>
        {
            Hide();
            ActionChosen?.Invoke(action, target);
        };

        return button;
    }

    private static GraphicsPath RoundedRectangle(Rectangle bounds, int radius)
    {
        GraphicsPath path = new();
        int diameter = radius * 2;
        path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180, 90);
        path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270, 90);
        path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0, 90);
        path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90, 90);
        path.CloseFigure();
        return path;
    }

    internal BubbleContent? CurrentContent => _content;

    protected override void Dispose(bool disposing)
    {
        if (disposing) _dismissTimer.Dispose();
        base.Dispose(disposing);
    }

    [EditorBrowsable(EditorBrowsableState.Never)]
    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        // Belt and braces with WS_EX_NOACTIVATE: if anything did manage to
        // activate us, hand focus straight back.
        TopMost = true;
    }
}
