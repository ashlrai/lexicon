import AppKit
import SwiftUI

/// Hosts the first-run flow in a real window (not a popover and not a sheet:
/// the user needs to leave for System Settings and come back to it).
@MainActor
final class OnboardingWindowController: NSWindowController, NSWindowDelegate {
    let model: OnboardingModel

    init(model: OnboardingModel) {
        self.model = model
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 560),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "Set up Lexicon"
        window.isReleasedWhenClosed = false
        window.setContentSize(NSSize(width: 640, height: 560))
        window.minSize = NSSize(width: 640, height: 560)
        window.center()
        super.init(window: window)
        window.delegate = self
        window.contentViewController = NSHostingController(rootView: OnboardingView(model: model))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func show() {
        // The app is an .accessory, so it has to ask for activation before a
        // window of its own can take focus.
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }
}
