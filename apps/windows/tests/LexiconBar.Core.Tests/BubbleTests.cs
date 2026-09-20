using System.Drawing;
using Xunit;

namespace LexiconBar.Tests;

public class BubbleContentTests
{
    private static FixReplacement R(string original, string replacement, string? reason = null) =>
        new(0, 0, original, replacement, reason);

    [Fact]
    public void NoReplacementsMeansNoBubble() =>
        Assert.Null(CorrectionBubble.Content(Array.Empty<FixReplacement>()));

    [Fact]
    public void TitleIsSingularForOneWord()
    {
        BubbleContent content = Assert.IsType<BubbleContent>(
            CorrectionBubble.Content(new[] { R("ashler", "Ashlr.AI", "alias") }));
        Assert.Equal("Fixed 1 word", content.Title);
        Assert.Null(content.Overflow);
        Assert.Equal("ashler → Ashlr.AI", content.Lines[0].Label);
        Assert.Equal("Fixed 1 word, ashler → Ashlr.AI", content.AccessibilityLabel);
    }

    [Fact]
    public void MoreThanThreeLinesOverflow()
    {
        FixReplacement[] replacements =
        {
            R("a", "A"), R("b", "B"), R("c", "C"), R("d", "D"), R("e", "E"),
        };
        BubbleContent content = Assert.IsType<BubbleContent>(CorrectionBubble.Content(replacements));
        Assert.Equal(3, content.Lines.Count);
        Assert.Equal("+2 more", content.Overflow);
        Assert.Equal(5, content.Total);
        Assert.Equal("Fixed 5 words", content.Title);
    }

    [Fact]
    public void AddIsOnlyOfferedForAGuess()
    {
        Assert.Equal(
            new[] { BubbleAction.Undo, BubbleAction.Never },
            CorrectionBubble.Actions(new[] { R("ashler", "Ashlr.AI", "alias") }));

        Assert.Equal(
            new[] { BubbleAction.Undo, BubbleAction.Never, BubbleAction.Add },
            CorrectionBubble.Actions(new[] { R("ashler", "Ashlr.AI", "phonetic") }));

        Assert.Equal(
            new[] { BubbleAction.Undo, BubbleAction.Never, BubbleAction.Add },
            CorrectionBubble.Actions(new[] { R("cuban eats", "Kubernetes", "fuzzy match") }));

        // A missing reason counts as not-a-guess.
        Assert.Equal(
            new[] { BubbleAction.Undo, BubbleAction.Never },
            CorrectionBubble.Actions(new[] { R("ashler", "Ashlr.AI") }));
    }

    [Fact]
    public void NeverAndAddActOnTheGuessedReplacementWhenThereIsOne()
    {
        BubbleContent content = Assert.IsType<BubbleContent>(CorrectionBubble.Content(new[]
        {
            R("ashler", "Ashlr.AI", "alias"),
            R("cuban eats", "Kubernetes", "phonetic"),
        }));
        Assert.Equal("cuban eats", content.Target.Original);

        BubbleContent noGuess = Assert.IsType<BubbleContent>(CorrectionBubble.Content(new[]
        {
            R("ashler", "Ashlr.AI", "alias"),
            R("versal", "Vercel", "alias"),
        }));
        Assert.Equal("ashler", noGuess.Target.Original);
    }
}

/// <summary>
/// Windows screen coordinates are y-down, the opposite of AppKit's, so this is
/// the one piece of geometry that is a rewrite rather than a port. These cases
/// are the y-flipped twins of <c>BubbleSupportTests.swift</c>.
/// </summary>
public class BubblePlacementTests
{
    // A 1920x1080 monitor with a 40px taskbar at the bottom.
    private static readonly Rectangle Work = new(0, 0, 1920, 1040);
    private static readonly Size Bubble = new(280, 96);

    [Fact]
    public void PreferredSpotIsBelowAndLeftAlignedWithTheCaret()
    {
        Rectangle caret = new(400, 300, 2, 18);
        Point origin = BubblePlacement.Origin(caret, Work, Bubble);
        Assert.Equal(400, origin.X);
        Assert.Equal(318 + BubblePlacement.Gap, origin.Y);
    }

    [Fact]
    public void NoRoomBelowFlipsAboveTheCaretRatherThanCoveringIt()
    {
        // Caret near the bottom of the work area: 1020 + 18 + 8 + 96 > 1040.
        Rectangle caret = new(400, 1020, 2, 18);
        Point origin = BubblePlacement.Origin(caret, Work, Bubble);
        Assert.Equal(1020 - BubblePlacement.Gap - Bubble.Height, origin.Y);
        Assert.True(origin.Y + Bubble.Height <= caret.Top);
    }

    [Fact]
    public void ACaretWithRoomNeitherWayIsClampedInsideTheScreen()
    {
        // 100px tall: no room below the caret, and flipping above would put the
        // bubble off the top. It ends up sitting on the bottom edge instead.
        Rectangle tiny = new(0, 0, 400, 100);
        Rectangle caret = new(10, 50, 2, 18);
        Point origin = BubblePlacement.Origin(caret, tiny, Bubble);
        Assert.Equal(tiny.Bottom - Bubble.Height, origin.Y);
        Assert.True(new Rectangle(origin, Bubble).IntersectsWith(tiny));
        Assert.True(origin.X >= tiny.Left);
    }

    [Fact]
    public void AScreenShorterThanTheBubbleClampsToTheTopSoTheTitleStaysVisible()
    {
        Rectangle sliver = new(0, 0, 400, 60);
        Point origin = BubblePlacement.Origin(new Rectangle(10, 20, 2, 18), sliver, Bubble);
        Assert.Equal(sliver.Top, origin.Y);
    }

    [Fact]
    public void TheRightEdgeIsClamped()
    {
        Rectangle caret = new(1900, 300, 2, 18);
        Point origin = BubblePlacement.Origin(caret, Work, Bubble);
        Assert.Equal(Work.Right - Bubble.Width, origin.X);
    }

    [Fact]
    public void ScreenContainingPrefersTheMonitorTheCaretIsOnAndFallsBackToTheNearest()
    {
        Rectangle left = new(0, 0, 1920, 1040);
        Rectangle right = new(1920, 0, 1920, 1040);
        List<Rectangle> screens = new() { left, right };

        Assert.Equal(left, BubblePlacement.ScreenContaining(new Point(100, 100), screens));
        Assert.Equal(right, BubblePlacement.ScreenContaining(new Point(2500, 100), screens));
        // A caret one pixel below every working area still lands somewhere.
        Assert.Equal(right, BubblePlacement.ScreenContaining(new Point(2500, 1041), screens));
        Assert.Null(BubblePlacement.ScreenContaining(new Point(0, 0), Array.Empty<Rectangle>()));
    }

    [Fact]
    public void NegativeMonitorOriginsWork()
    {
        // A second monitor placed above-left of the primary has negative coords.
        Rectangle above = new(-1920, -1080, 1920, 1040);
        Rectangle caret = new(-1000, -500, 2, 18);
        Point origin = BubblePlacement.Origin(caret, above, Bubble);
        Assert.Equal(-1000, origin.X);
        Assert.Equal(-500 + 18 + BubblePlacement.Gap, origin.Y);
    }
}
