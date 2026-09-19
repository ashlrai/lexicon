import AppKit

// Entry point. `.accessory` keeps the app out of the Dock even when the bare
// executable is run from `swift build` (the packaged .app also sets
// LSUIElement in its Info.plist).
@main
@MainActor
enum LexiconBarMain {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }
}
