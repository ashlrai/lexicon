import Foundation
import CoreGraphics

/// The pure half of the correction bubble: what it says, which buttons it
/// offers, and where on screen it goes. The AppKit panel that draws it lives
/// in `LexiconBar/CorrectionBubble/`.

/// A button on the bubble.
public enum BubbleAction: String, Equatable, Sendable, CaseIterable {
    /// Put the dictated text back (the same thing ⌃⌥Z does).
    case undo
    /// "that word was right": records the original under the term's `never` list and undoes.
    case never
    /// "that guess was right": promotes the original to an explicit alias.
    /// Only offered when the rewrite came from a phonetic or fuzzy guess —
    /// an exact alias is already explicit, so there is nothing to add.
    case add
}

/// One `original → canonical` row. The view draws `original` struck through
/// and `canonical` bold; keeping them apart is what makes that testable.
public struct BubbleLine: Equatable, Sendable {
    public let original: String
    public let canonical: String
    /// The API's reason for this rewrite ("alias", "phonetic", "fuzzy", ...), when it gave one.
    public let reason: String?

    public init(original: String, canonical: String, reason: String? = nil) {
        self.original = original
        self.canonical = canonical
        self.reason = reason
    }

    /// Plain-text form, for logs, tooltips and the accessibility label.
    public var label: String { "\(original) \u{2192} \(canonical)" }
}

/// Everything the panel needs to render one correction event.
public struct BubbleContent: Equatable, Sendable {
    /// At most `maxLines` rows, in the order the API reported them.
    public let lines: [BubbleLine]
    /// "+4 more" when replacements were dropped, nil when they all fit.
    public let overflow: String?
    /// Which buttons to show, in display order.
    public let actions: [BubbleAction]
    /// The replacement "Never" and "Add" act on: the first guessed one if
    /// there is one, else the first replacement.
    public let target: BubbleLine
    /// Total replacement count, including the ones past `maxLines`.
    public let total: Int

    public init(lines: [BubbleLine], overflow: String?, actions: [BubbleAction], target: BubbleLine, total: Int) {
        self.lines = lines
        self.overflow = overflow
        self.actions = actions
        self.target = target
        self.total = total
    }

    /// "Fixed 1 word" / "Fixed 3 words".
    public var title: String { total == 1 ? "Fixed 1 word" : "Fixed \(total) words" }

    /// One line for VoiceOver and for the notification fallback.
    public var accessibilityLabel: String {
        ([title] + lines.map(\.label) + [overflow].compactMap { $0 }).joined(separator: ", ")
    }
}

public enum CorrectionBubble {
    /// How many rows fit before the bubble starts counting instead.
    public static let maxLines = 3

    /// True for the reasons that mean "the matcher guessed": those are the
    /// ones worth promoting to an explicit alias with `POST /learn`.
    /// A missing reason counts as not-a-guess, so `Add` stays hidden rather
    /// than offering to learn something that may already be exact.
    public static func isGuess(reason: String?) -> Bool {
        guard let reason = reason?.lowercased() else { return false }
        return reason.contains("phonetic") || reason.contains("fuzzy")
    }

    /// nil when there is nothing to show (no replacements).
    public static func content(for replacements: [Replacement], maxLines: Int = CorrectionBubble.maxLines) -> BubbleContent? {
        let all = replacements.map { BubbleLine(original: $0.original, canonical: $0.replacement, reason: $0.reason) }
        guard let first = all.first else { return nil }
        let limit = max(1, maxLines)
        let shown = Array(all.prefix(limit))
        let dropped = all.count - shown.count
        let target = all.first(where: { isGuess(reason: $0.reason) }) ?? first
        return BubbleContent(
            lines: shown,
            overflow: dropped > 0 ? "+\(dropped) more" : nil,
            actions: actions(for: replacements),
            target: target,
            total: all.count
        )
    }

    /// Undo and Never are always available; Add only when at least one
    /// replacement came from a phonetic or fuzzy guess.
    public static func actions(for replacements: [Replacement]) -> [BubbleAction] {
        var actions: [BubbleAction] = [.undo, .never]
        if replacements.contains(where: { isGuess(reason: $0.reason) }) { actions.append(.add) }
        return actions
    }
}

/// Where the bubble sits relative to the caret.
///
/// Everything here is in AppKit screen coordinates: origin bottom-left, y
/// growing upwards, which is what `NSWindow.setFrameOrigin` wants. The AX API
/// hands back Quartz rects (y down from the top of the main display); the
/// caller flips them before calling in.
public enum BubblePlacement {
    /// Distance between the caret and the bubble.
    public static let gap: CGFloat = 8

    /// Preferred spot is just below and left-aligned with the caret, clamped
    /// into `screen` (pass a `visibleFrame`, which already excludes the menu
    /// bar, the notch and the Dock).
    ///
    /// When there is no room below, the bubble flips above the caret rather
    /// than covering the text the user is typing. When there is no room
    /// either way it is clamped inside the screen, bottom edge first.
    public static func origin(caret: CGRect, screen: CGRect, bubble: CGSize, gap: CGFloat = BubblePlacement.gap) -> CGPoint {
        var x = caret.minX
        // Right edge first, then left: on a screen narrower than the bubble
        // the left clamp wins and the bubble starts at the screen edge.
        if x + bubble.width > screen.maxX { x = screen.maxX - bubble.width }
        if x < screen.minX { x = screen.minX }

        var y = caret.minY - gap - bubble.height
        if y < screen.minY {
            let above = caret.maxY + gap
            // Only flip if above actually fits; otherwise stay below and clamp.
            y = above + bubble.height <= screen.maxY ? above : screen.minY
        }
        if y + bubble.height > screen.maxY { y = screen.maxY - bubble.height }
        if y < screen.minY { y = screen.minY }

        return CGPoint(x: x, y: y)
    }

    /// The frame among `screens` that contains `point`, else the one whose
    /// centre is nearest (a caret can sit a pixel outside every visibleFrame),
    /// else nil when there are no screens.
    public static func screen(containing point: CGPoint, screens: [CGRect]) -> CGRect? {
        if let hit = screens.first(where: { $0.contains(point) }) { return hit }
        return screens.min { a, b in
            distanceSquared(from: point, toCenterOf: a) < distanceSquared(from: point, toCenterOf: b)
        }
    }

    private static func distanceSquared(from point: CGPoint, toCenterOf rect: CGRect) -> CGFloat {
        let dx = point.x - rect.midX
        let dy = point.y - rect.midY
        return dx * dx + dy * dy
    }
}
