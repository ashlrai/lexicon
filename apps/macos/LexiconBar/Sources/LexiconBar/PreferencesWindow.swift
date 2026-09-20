import AppKit
import SwiftUI
import UniformTypeIdentifiers
import LexiconBarKit

/// Hosts the SwiftUI preferences form in a regular window.
@MainActor
final class PreferencesWindowController: NSWindowController {
    init(settings: Settings, status: CLIStatusModel) {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 720),
                              styleMask: [.titled, .closable, .miniaturizable],
                              backing: .buffered, defer: false)
        window.title = "LexiconBar Preferences"
        window.isReleasedWhenClosed = false
        window.center()
        super.init(window: window)
        window.contentViewController = NSHostingController(rootView: PreferencesView(settings: settings, status: status))
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        showWindow(nil)
        window?.makeKeyAndOrderFront(nil)
    }
}

/// Read-only state the preferences window displays (resolved CLI path etc.).
@MainActor
final class CLIStatusModel: ObservableObject {
    @Published var resolvedPath: String?
    @Published var detecting = false
    /// Set by the app; called when the user asks to re-detect or changes the path.
    var redetect: (() -> Void)?
}

struct PreferencesView: View {
    @ObservedObject var settings: Settings
    @ObservedObject var status: CLIStatusModel

    var body: some View {
        Form {
            Section("lexicon CLI") {
                HStack {
                    TextField("Path (empty = auto-detect)", text: $settings.cliPath)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { status.redetect?() }
                    Button("Choose…") { choosePath() }
                }
                HStack(spacing: 6) {
                    if status.detecting {
                        ProgressView().controlSize(.small)
                        Text("Detecting…").foregroundStyle(.secondary)
                    } else if let path = status.resolvedPath {
                        Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                        Text(path).font(.caption).foregroundStyle(.secondary).lineLimit(2).truncationMode(.middle)
                    } else {
                        Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        Text("Not found. Install with `npm i -g @ashlr/lexicon` or pick the file.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button("Re-detect") { status.redetect?() }.controlSize(.small)
                }
                Text("Accepts the `lexicon` binary or a `dist/cli/index.js` (run with node).")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Voice") {
                Picker("Whisper model", selection: $settings.model) {
                    ForEach(Settings.models, id: \.self) { Text($0) }
                }
                Picker("After transcribing", selection: $settings.pasteMode) {
                    Text("Paste into the frontmost app").tag(true)
                    Text("Copy to the clipboard only").tag(false)
                }
                .pickerStyle(.radioGroup)
            }

            Section("Fix everywhere") {
                Toggle("Correct dictated text in any app", isOn: $settings.fixEverywhere)
                Text("Watches the focused text field through Accessibility. When a dictation tool drops in a phrase, the phrase is sent to `lexicon serve` and rewritten in place once it has settled. Typing key by key is never touched.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Text("Settle delay")
                    Slider(value: $settings.fixSettleMs, in: Settings.settleRange, step: 50)
                    Text("\(Int(settings.fixSettleMs)) ms").monospacedDigit().frame(width: 64, alignment: .trailing)
                }
                Stepper("Minimum words: \(settings.fixMinWords)", value: $settings.fixMinWords, in: Settings.minWordsRange)
                Toggle("Notify on each fix", isOn: $settings.fixNotify)
                ExcludedAppsEditor(bundleIDs: $settings.fixExcludedApps)
            }

            Section("Hotkeys") {
                HotKeyRow(title: "Push to talk", hotKey: $settings.pushToTalkHotKey)
                HotKeyRow(title: "Fix clipboard now", hotKey: $settings.fixClipboardHotKey)
                HotKeyRow(title: "Undo last fix", hotKey: $settings.undoFixHotKey)
                Text("Click a field and press the new combination. Escape cancels. Hotkeys work without Accessibility permission; pasting and Fix everywhere need it.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
        .frame(width: 560)
        .padding(.bottom, 8)
    }

    private func choosePath() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.treatsFilePackagesAsDirectories = true
        panel.message = "Pick the lexicon executable or dist/cli/index.js"
        if panel.runModal() == .OK, let url = panel.url {
            settings.cliPath = url.path
            status.redetect?()
        }
    }
}

/// The bundle ids "Fix everywhere" stays out of. Add by typing an id or
/// picking an app (its Info.plist supplies the id); remove with the minus.
struct ExcludedAppsEditor: View {
    @Binding var bundleIDs: [String]
    @State private var newID = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Excluded apps").font(.subheadline)
            if bundleIDs.isEmpty {
                Text("None. Terminals and password managers are excluded by default; click Reset to restore that list.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(bundleIDs, id: \.self) { id in
                HStack {
                    Text(id).font(.system(.body, design: .monospaced)).lineLimit(1).truncationMode(.middle)
                    Spacer()
                    Button { bundleIDs.removeAll { $0 == id } } label: { Image(systemName: "minus.circle") }
                        .buttonStyle(.borderless)
                        .help("Allow Fix everywhere in this app again")
                }
            }
            HStack {
                TextField("com.example.app or com.example.*", text: $newID)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit(addTyped)
                Button("Add", action: addTyped).disabled(newID.trimmingCharacters(in: .whitespaces).isEmpty)
                Button("Choose app\u{2026}", action: chooseApp)
                Button("Reset") { bundleIDs = AppExclusions.defaults }
            }
            Text("A trailing `.*` matches a prefix. Bundle ids are matched case-insensitively.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func addTyped() {
        var exclusions = AppExclusions(bundleIDs: bundleIDs)
        exclusions.exclude(newID)
        bundleIDs = exclusions.bundleIDs
        newID = ""
    }

    private func chooseApp() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.applicationBundle]
        panel.directoryURL = URL(fileURLWithPath: "/Applications")
        panel.message = "Pick the apps Fix everywhere should leave alone"
        guard panel.runModal() == .OK else { return }
        var exclusions = AppExclusions(bundleIDs: bundleIDs)
        for url in panel.urls {
            if let id = Bundle(url: url)?.bundleIdentifier { exclusions.exclude(id) }
        }
        bundleIDs = exclusions.bundleIDs
    }
}

struct HotKeyRow: View {
    let title: String
    @Binding var hotKey: HotKey

    var body: some View {
        HStack {
            Text(title)
            Spacer()
            HotKeyRecorder(hotKey: $hotKey)
                .frame(width: 150, height: 24)
            Menu {
                ForEach(HotKey.presets, id: \.self) { preset in
                    Button(preset.displayString) { hotKey = preset }
                }
            } label: {
                Text("Presets")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
        }
    }
}

/// A click-to-record field. Captures the next key press (with modifiers)
/// while focused; Escape cancels. Only combinations `HotKey.isValid` accepts
/// are stored.
struct HotKeyRecorder: NSViewRepresentable {
    @Binding var hotKey: HotKey

    func makeNSView(context: Context) -> RecorderView {
        let view = RecorderView()
        view.onChange = { hotKey = $0 }
        view.hotKey = hotKey
        return view
    }

    func updateNSView(_ nsView: RecorderView, context: Context) {
        nsView.hotKey = hotKey
        nsView.onChange = { hotKey = $0 }
    }

    final class RecorderView: NSView {
        var hotKey: HotKey = .defaultPushToTalk { didSet { needsDisplay = true } }
        var onChange: ((HotKey) -> Void)?
        private var recording = false { didSet { needsDisplay = true } }

        override var acceptsFirstResponder: Bool { true }
        override var focusRingType: NSFocusRingType { get { .none } set {} }

        override func mouseDown(with event: NSEvent) {
            window?.makeFirstResponder(self)
            recording = true
        }

        override func becomeFirstResponder() -> Bool { recording = true; return true }
        override func resignFirstResponder() -> Bool { recording = false; return true }

        override func keyDown(with event: NSEvent) {
            guard recording else { super.keyDown(with: event); return }
            if event.keyCode == UInt16(HotKey.keyEscape) {
                window?.makeFirstResponder(nil)
                return
            }
            let modifiers = HotKey.modifiers(fromAppKitFlags: event.modifierFlags.rawValue)
            let candidate = HotKey(keyCode: UInt32(event.keyCode), modifiers: modifiers)
            guard candidate.isValid else { NSSound.beep(); return }
            hotKey = candidate
            onChange?(candidate)
            window?.makeFirstResponder(nil)
        }

        override func flagsChanged(with event: NSEvent) {
            needsDisplay = true
        }

        override func draw(_ dirtyRect: NSRect) {
            let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: 5, yRadius: 5)
            (recording ? NSColor.controlAccentColor.withAlphaComponent(0.12) : NSColor.controlBackgroundColor).setFill()
            path.fill()
            (recording ? NSColor.controlAccentColor : NSColor.separatorColor).setStroke()
            path.stroke()
            let text = recording ? "Press keys…" : hotKey.displayString
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 12),
                .foregroundColor: recording ? NSColor.secondaryLabelColor : NSColor.labelColor,
            ]
            let size = (text as NSString).size(withAttributes: attrs)
            let origin = NSPoint(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2)
            (text as NSString).draw(at: origin, withAttributes: attrs)
        }
    }
}
