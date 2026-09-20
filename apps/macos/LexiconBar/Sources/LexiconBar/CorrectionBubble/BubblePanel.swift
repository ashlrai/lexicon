import AppKit
import LexiconBarKit

/// The floating "we just fixed this" panel that appears near the caret after
/// a Fix-everywhere rewrite, Grammarly style.
///
/// It must never take keyboard focus: the user is mid-sentence in another app
/// and a stolen focus would swallow the next word. So the panel is a
/// `.nonactivatingPanel` with `canBecomeKey` forced false, and everything that
/// would normally arrive as a key event (Escape, a click elsewhere) comes in
/// through global event monitors instead.
///
/// One instance is reused for every fix; panels never stack.
@MainActor
final class CorrectionBubbleController {
    /// Fade-in duration. Long enough not to pop, short enough that the bubble
    /// is fully there before the user's eye arrives.
    static let fadeIn: TimeInterval = 0.12
    private static let fadeOut: TimeInterval = 0.1

    /// Called on the main thread when the user presses a button. The line is
    /// the replacement the action applies to (`BubbleContent.target`).
    var onAction: ((BubbleAction, BubbleLine) -> Void)?

    private var panel: BubblePanel?
    private var contentView: BubbleContentView?
    private var dismissTimer: Timer?
    private var seconds: TimeInterval = 4
    private var monitors: [Any] = []
    private var workspaceToken: NSObjectProtocol?
    private var hovering = false

    var isVisible: Bool { panel?.isVisible == true }

    // MARK: show / hide

    /// Replaces whatever is on screen with `content`, placed under `caret`.
    /// `caret` is in Quartz global coordinates (y down from the top of the
    /// primary display), which is what the AX API hands back; nil falls back
    /// to the mouse.
    func show(_ content: BubbleContent, caret: CGRect?, seconds: TimeInterval) {
        self.seconds = seconds
        let panel = existingPanel()
        let view = contentView ?? BubbleContentView()
        contentView = view
        view.onAction = { [weak self] action in self?.perform(action) }
        view.onHoverChanged = { [weak self] hovering in self?.hoverChanged(hovering) }
        view.apply(content)
        panel.contentView = view

        let size = view.fittingSize
        let origin = Self.origin(caret: caret, bubble: size)
        panel.setFrame(NSRect(origin: origin, size: size), display: false)

        // Never steal focus: orderFrontRegardless puts the panel up without
        // activating LexiconBar or changing the key window.
        if panel.isVisible {
            // A new burst replaced the old bubble; it is already faded in.
            panel.alphaValue = 1
        } else {
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            NSAnimationContext.runAnimationGroup { context in
                context.duration = Self.fadeIn
                panel.animator().alphaValue = 1
            }
        }
        startMonitoring()
        armTimer()
    }

    func dismiss() {
        dismissTimer?.invalidate()
        dismissTimer = nil
        stopMonitoring()
        hovering = false
        guard let panel, panel.isVisible else { return }
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = Self.fadeOut
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak panel] in
            panel?.orderOut(nil)
        })
    }

    // MARK: placement

    /// Quartz (y down, primary display at the top left) to AppKit (y up).
    static func flipFromQuartz(_ rect: CGRect) -> CGRect {
        guard let primary = NSScreen.screens.first else { return rect }
        return CGRect(x: rect.origin.x, y: primary.frame.maxY - rect.origin.y - rect.height,
                      width: rect.width, height: rect.height)
    }

    /// Caret rect (Quartz) plus bubble size to a bottom-left origin in AppKit
    /// coordinates, clamped to the screen the caret is on. Falls back to the
    /// mouse location, which is already in AppKit coordinates.
    private static func origin(caret: CGRect?, bubble: CGSize) -> CGPoint {
        let anchor: CGRect
        if let caret, caret.height > 0 {
            anchor = flipFromQuartz(caret)
        } else {
            let mouse = NSEvent.mouseLocation
            anchor = CGRect(x: mouse.x, y: mouse.y, width: 1, height: 18)
        }
        let frames = NSScreen.screens.map(\.visibleFrame)
        let point = CGPoint(x: anchor.minX, y: anchor.midY)
        // visibleFrame already excludes the menu bar, the notch and the Dock.
        let screen = BubblePlacement.screen(containing: point, screens: frames)
            ?? NSScreen.main?.visibleFrame
            ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return BubblePlacement.origin(caret: anchor, screen: screen, bubble: bubble)
    }

    // MARK: timer and dismissal

    private func armTimer() {
        dismissTimer?.invalidate()
        guard !hovering else { return }
        dismissTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            DispatchQueue.main.async { self?.dismiss() }
        }
        // The user may be scrolling or dragging in the other app; keep counting.
        if let dismissTimer { RunLoop.main.add(dismissTimer, forMode: .common) }
    }

    /// Hovering pauses the countdown so a bubble cannot vanish from under the
    /// pointer on its way to Undo; leaving restarts it from the top.
    private func hoverChanged(_ hovering: Bool) {
        self.hovering = hovering
        if hovering {
            dismissTimer?.invalidate()
            dismissTimer = nil
        } else {
            armTimer()
        }
    }

    private func perform(_ action: BubbleAction) {
        guard let line = contentView?.content?.target else { return }
        dismiss()
        onAction?(action, line)
    }

    // MARK: event monitors

    /// The panel never becomes key, so Escape, clicks elsewhere and further
    /// typing are all observed globally instead of through the responder chain.
    private func startMonitoring() {
        guard monitors.isEmpty else { return }
        // Escape, or any other keystroke: the user has gone back to writing
        // and the next burst will bring its own bubble. Modifier-only presses
        // arrive as `flagsChanged`, not `keyDown`, so holding Command to take
        // a screenshot of the bubble does not close it.
        let keys = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown], handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.dismiss() }
        })
        // Any click outside our own panel; clicks on the panel itself are
        // local events and do not reach a global monitor.
        let clicks = NSEvent.addGlobalMonitorForEvents(
            matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown],
            handler: { [weak self] _ in
                MainActor.assumeIsolated { self?.dismiss() }
            })
        // Escape typed into one of LexiconBar's own windows.
        let local = NSEvent.addLocalMonitorForEvents(matching: [.keyDown], handler: { [weak self] event in
            MainActor.assumeIsolated {
                if event.keyCode == UInt16(HotKey.keyEscape) { self?.dismiss() }
            }
            return event
        })
        monitors = [keys, clicks, local].compactMap { $0 }

        workspaceToken = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.dismiss() }
        }
    }

    private func stopMonitoring() {
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        monitors = []
        if let workspaceToken {
            NSWorkspace.shared.notificationCenter.removeObserver(workspaceToken)
            self.workspaceToken = nil
        }
    }

    // MARK: the panel

    private func existingPanel() -> BubblePanel {
        if let panel { return panel }
        let panel = BubblePanel(
            contentRect: NSRect(x: 0, y: 0, width: 300, height: 120),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered, defer: false)
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.animationBehavior = .none
        panel.ignoresMouseEvents = false
        // Out of screenshots and screen sharing would be wrong here: the
        // bubble is part of what the user sees, and the verification step
        // screenshots it.
        panel.sharingType = .readOnly
        self.panel = panel
        return panel
    }
}

/// `canBecomeKey` is the whole point: a key panel would take the keystrokes
/// the user is aiming at their editor.
private final class BubblePanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
    /// Borderless windows refuse to accept mouse events in an inactive app
    /// unless this is set; without it the three buttons need two clicks.
    override var acceptsFirstResponder: Bool { false }
}

/// The bubble's contents: a title row, up to three `original → canonical`
/// lines, an overflow count, and the action buttons.
private final class BubbleContentView: NSView {
    private enum Metrics {
        static let corner: CGFloat = 10
        static let padding: CGFloat = 12
        static let rowSpacing: CGFloat = 4
        static let minWidth: CGFloat = 240
        static let maxWidth: CGFloat = 420
    }

    var onAction: ((BubbleAction) -> Void)?
    var onHoverChanged: ((Bool) -> Void)?
    private(set) var content: BubbleContent?

    private let background = NSVisualEffectView()
    private let stack = NSStackView()
    private let titleLabel = NSTextField(labelWithString: "")
    private let linesStack = NSStackView()
    private let buttonsStack = NSStackView()
    private var tracking: NSTrackingArea?

    init() {
        super.init(frame: NSRect(x: 0, y: 0, width: Metrics.minWidth, height: 100))
        wantsLayer = true

        background.material = .popover
        background.blendingMode = .behindWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = Metrics.corner
        background.layer?.cornerCurve = .continuous
        background.layer?.masksToBounds = true
        background.layer?.borderWidth = 1
        background.layer?.borderColor = NSColor.separatorColor.cgColor
        background.translatesAutoresizingMaskIntoConstraints = false
        addSubview(background)

        titleLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        titleLabel.textColor = .secondaryLabelColor

        linesStack.orientation = .vertical
        linesStack.alignment = .leading
        linesStack.spacing = Metrics.rowSpacing

        buttonsStack.orientation = .horizontal
        buttonsStack.alignment = .centerY
        buttonsStack.spacing = 6

        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: Metrics.padding, left: Metrics.padding,
                                        bottom: Metrics.padding, right: Metrics.padding)
        stack.setViews([titleLabel, linesStack, buttonsStack], in: .leading)
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)

        NSLayoutConstraint.activate([
            background.leadingAnchor.constraint(equalTo: leadingAnchor),
            background.trailingAnchor.constraint(equalTo: trailingAnchor),
            background.topAnchor.constraint(equalTo: topAnchor),
            background.bottomAnchor.constraint(equalTo: bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor),
            stack.topAnchor.constraint(equalTo: topAnchor),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor),
            widthAnchor.constraint(greaterThanOrEqualToConstant: Metrics.minWidth),
            widthAnchor.constraint(lessThanOrEqualToConstant: Metrics.maxWidth),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var isFlipped: Bool { true }

    func apply(_ content: BubbleContent) {
        self.content = content
        titleLabel.stringValue = content.title

        linesStack.setViews(content.lines.map(Self.lineLabel), in: .leading)
        if let overflow = content.overflow {
            let more = NSTextField(labelWithString: overflow)
            more.font = .systemFont(ofSize: 11)
            more.textColor = .tertiaryLabelColor
            linesStack.addView(more, in: .leading)
        }

        buttonsStack.setViews(content.actions.map { action in
            self.button(for: action, target: content.target)
        }, in: .leading)

        setAccessibilityLabel(content.accessibilityLabel)
        needsLayout = true
        layoutSubtreeIfNeeded()
    }

    /// "ashler → Ashlr.AI": the heard spelling struck through and dimmed, the
    /// canonical bold, so the eye lands on what the field now says.
    private static func lineLabel(for line: BubbleLine) -> NSTextField {
        let text = NSMutableAttributedString()
        text.append(NSAttributedString(string: line.original, attributes: [
            .font: NSFont.systemFont(ofSize: 12),
            .foregroundColor: NSColor.secondaryLabelColor,
            .strikethroughStyle: NSUnderlineStyle.single.rawValue,
            .strikethroughColor: NSColor.tertiaryLabelColor,
        ]))
        text.append(NSAttributedString(string: "  \u{2192}  ", attributes: [
            .font: NSFont.systemFont(ofSize: 11),
            .foregroundColor: NSColor.tertiaryLabelColor,
        ]))
        text.append(NSAttributedString(string: line.canonical, attributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold),
            .foregroundColor: NSColor.labelColor,
        ]))
        let label = NSTextField(labelWithAttributedString: text)
        label.lineBreakMode = .byTruncatingMiddle
        label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return label
    }

    private func button(for action: BubbleAction, target: BubbleLine) -> NSButton {
        let title: String
        let help: String
        switch action {
        case .undo:
            title = "Undo"
            help = "Put \u{201C}\(target.original)\u{201D} back (also \u{2303}\u{2325}Z)"
        case .never:
            title = "Never"
            help = "Leave \u{201C}\(target.original)\u{201D} alone from now on, and undo this fix"
        case .add:
            title = "Add"
            help = "Remember \u{201C}\(target.original)\u{201D} as a spelling of \u{201C}\(target.canonical)\u{201D}"
        }
        let button = NSButton(title: title, target: self, action: #selector(buttonPressed(_:)))
        button.bezelStyle = .rounded
        button.controlSize = .small
        button.font = .systemFont(ofSize: 11)
        button.toolTip = help
        button.setAccessibilityLabel(help)
        button.tag = BubbleAction.allCases.firstIndex(of: action) ?? 0
        return button
    }

    @objc private func buttonPressed(_ sender: NSButton) {
        guard BubbleAction.allCases.indices.contains(sender.tag) else { return }
        onAction?(BubbleAction.allCases[sender.tag])
    }

    // MARK: hover

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways], owner: self)
        addTrackingArea(area)
        tracking = area
    }

    override func mouseEntered(with event: NSEvent) { onHoverChanged?(true) }
    override func mouseExited(with event: NSEvent) { onHoverChanged?(false) }
}
