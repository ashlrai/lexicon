using System.Drawing;

namespace LexiconBar;

/// <summary>
/// Where the bubble sits relative to the caret.
///
/// **This is the one piece of geometry that is not a straight port.** AppKit
/// screen coordinates have their origin bottom-left with y growing upwards, so
/// the Mac version puts the bubble *below* the caret by subtracting from y.
/// Windows screen coordinates have their origin top-left with y growing
/// downwards, so "below" means adding. The shape of the logic — prefer below
/// and left-aligned, flip above rather than cover the text being written, clamp
/// into the work area — is the same, and the tests cover both the flip and the
/// clamp.
///
/// Pass the monitor's *working* area (<c>Screen.WorkingArea</c>), which already
/// excludes the taskbar.
/// </summary>
public static class BubblePlacement
{
    /// <summary>Distance between the caret and the bubble, in pixels.</summary>
    public const int Gap = 8;

    /// <summary>
    /// Preferred spot is just below and left-aligned with the caret, clamped
    /// into <paramref name="screen"/>. When there is no room below, the bubble
    /// flips above the caret rather than covering the text the user is writing.
    /// When there is no room either way it is clamped inside the screen, top
    /// edge last so the title stays visible.
    /// </summary>
    public static Point Origin(Rectangle caret, Rectangle screen, Size bubble, int gap = Gap)
    {
        int x = caret.Left;
        // Right edge first, then left: on a screen narrower than the bubble the
        // left clamp wins and the bubble starts at the screen edge.
        if (x + bubble.Width > screen.Right) x = screen.Right - bubble.Width;
        if (x < screen.Left) x = screen.Left;

        int y = caret.Bottom + gap;
        if (y + bubble.Height > screen.Bottom)
        {
            int above = caret.Top - gap - bubble.Height;
            // Only flip if above actually fits; otherwise stay below and clamp.
            y = above >= screen.Top ? above : screen.Bottom - bubble.Height;
        }

        if (y + bubble.Height > screen.Bottom) y = screen.Bottom - bubble.Height;
        if (y < screen.Top) y = screen.Top;

        return new Point(x, y);
    }

    /// <summary>
    /// The screen rectangle among <paramref name="screens"/> that contains
    /// <paramref name="point"/>, else the one whose centre is nearest (a caret
    /// can sit a pixel outside every working area), else null when there are no
    /// screens.
    /// </summary>
    public static Rectangle? ScreenContaining(Point point, IReadOnlyList<Rectangle> screens)
    {
        foreach (Rectangle screen in screens)
        {
            if (screen.Contains(point)) return screen;
        }

        Rectangle? best = null;
        long bestDistance = long.MaxValue;
        foreach (Rectangle screen in screens)
        {
            long distance = DistanceSquared(point, screen);
            if (distance >= bestDistance) continue;
            bestDistance = distance;
            best = screen;
        }
        return best;
    }

    private static long DistanceSquared(Point point, Rectangle rect)
    {
        long dx = point.X - (rect.Left + rect.Width / 2);
        long dy = point.Y - (rect.Top + rect.Height / 2);
        return (dx * dx) + (dy * dy);
    }
}
