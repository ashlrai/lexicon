import AppKit
import Combine
import ServiceManagement
import LexiconBarKit

/// Status item, menu, and the glue between the CLI, hotkeys, child processes
/// and windows. Every CLI call goes through `LexiconCLI` (off main) and lands
/// back here on the main thread.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    enum VoiceState: Equatable {
        case idle
        case recording
        case transcribing
        case fixingClipboard
    }

    private let settings = Settings()
    private let runner = CommandRunner()
    private lazy var cli = LexiconCLI(runner: runner)
    private let hotKeys = HotKeyCenter()
    private let notifier = Notifier()
    private let cliStatus = CLIStatusModel()

    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private var preferencesWindow: PreferencesWindowController?
    private var doctorWindow: TextWindowController?
    private var cancellables: Set<AnyCancellable> = []

    private var daemon: ChildProcessSupervisor!
    private var server: ChildProcessSupervisor!

    private var voiceState: VoiceState = .idle { didSet { updateStatusIcon() } }
    private var lastReplacements: [Replacement] = []
    private var lastSummary: String?
    private var statusPollTimer: Timer?
    private var statusPollInFlight = false
    private var pushToTalkHotKeyID: UInt32?
    private var fixClipboardHotKeyID: UInt32?
    private var lastError: String?

    // MARK: lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.imagePosition = .imageOnly
        updateStatusIcon()
        menu.delegate = self
        statusItem.menu = menu
        rebuildMenu()

        daemon = ChildProcessSupervisor(name: "daemon", arguments: ["daemon", "--quiet"], cli: cli)
        server = ChildProcessSupervisor(name: "serve", arguments: ["serve"], cli: cli)
        daemon.onStateChange = { [weak self] state in self?.childStateChanged(name: "Watch clipboard", state: state, setting: \.watchClipboard) }
        server.onStateChange = { [weak self] state in self?.childStateChanged(name: "Local API", state: state, setting: \.localAPI) }

        cliStatus.redetect = { [weak self] in self?.detectCLI() }
        settings.$pushToTalkHotKey.dropFirst().sink { [weak self] _ in self?.registerHotKeys() }.store(in: &cancellables)
        settings.$fixClipboardHotKey.dropFirst().sink { [weak self] _ in self?.registerHotKeys() }.store(in: &cancellables)

        registerHotKeys()
        detectCLI()
        NSLog("LexiconBar %@ launched: status item visible=%d, bundled=%d, push-to-talk=%@",
              Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
              statusItem.isVisible ? 1 : 0, Notifier.isBundled ? 1 : 0, settings.pushToTalkHotKey.displayString)
    }

    func applicationWillTerminate(_ notification: Notification) {
        statusPollTimer?.invalidate()
        hotKeys.unregisterAll()
        daemon.terminateChild()
        server.terminateChild()
    }

    // MARK: CLI discovery

    private func detectCLI() {
        cliStatus.detecting = true
        CLIDiscovery.discover(runner: runner, preferredPath: settings.cliPath, bundleURL: Notifier.isBundled ? Bundle.main.bundleURL : nil) { [weak self] outcome in
            guard let self else { return }
            self.runner.childPATH = outcome.locator.childPATH(current: ProcessInfo.processInfo.environment["PATH"])
            self.cli.setLocation(outcome.location)
            self.cliStatus.detecting = false
            self.cliStatus.resolvedPath = outcome.location?.displayPath
            NSLog("LexiconBar: lexicon CLI %@", outcome.location.map { "at \($0.displayPath)" } ?? "not found")
            self.rebuildMenu()
            if outcome.location != nil {
                self.syncVoiceStatus()
                if self.settings.watchClipboard, !self.daemon.isRunning { self.daemon.start() }
                if self.settings.localAPI, !self.server.isRunning { self.server.start() }
            }
        }
    }

    // MARK: menu

    func menuNeedsUpdate(_ menu: NSMenu) {
        rebuildMenu()
    }

    private func rebuildMenu() {
        menu.removeAllItems()
        let available = cli.isAvailable
        let busy = voiceState == .transcribing || voiceState == .fixingClipboard

        if !available {
            let item = NSMenuItem(title: "lexicon CLI not found \u{2013} Preferences\u{2026}", action: #selector(openPreferences), keyEquivalent: "")
            item.target = self
            item.image = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: nil)
            menu.addItem(item)
            menu.addItem(.separator())
        }

        let pttTitle: String
        switch voiceState {
        case .idle: pttTitle = "Push to talk (\(settings.pushToTalkHotKey.displayString))"
        case .recording: pttTitle = "Stop recording (\(settings.pushToTalkHotKey.displayString))"
        case .transcribing: pttTitle = "Transcribing\u{2026}"
        case .fixingClipboard: pttTitle = "Push to talk (\(settings.pushToTalkHotKey.displayString))"
        }
        let ptt = add(pttTitle, #selector(togglePushToTalk), enabled: available && !busy)
        ptt.state = voiceState == .recording ? .on : .off

        add(voiceState == .fixingClipboard ? "Fixing clipboard\u{2026}" : "Fix clipboard now (\(settings.fixClipboardHotKey.displayString))",
            #selector(fixClipboardNow), enabled: available && !busy)

        menu.addItem(.separator())

        let watch = add("Watch clipboard", #selector(toggleWatchClipboard), enabled: available)
        watch.state = daemon?.isRunning == true ? .on : (settings.watchClipboard && available ? .mixed : .off)
        let api = add("Local API", #selector(toggleLocalAPI), enabled: available)
        api.state = server?.isRunning == true ? .on : (settings.localAPI && available ? .mixed : .off)
        if server?.isRunning == true {
            add("Show API URL and token\u{2026}", #selector(showAPIInfo), enabled: available, indent: 1)
        }
        if let daemon, case .failed(let why) = daemon.state {
            addInfo("Clipboard watcher stopped: \(why)", indent: 1)
        }
        if let server, case .failed(let why) = server.state {
            addInfo("Local API stopped: \(why)", indent: 1)
        }

        menu.addItem(.separator())

        let last = NSMenuItem(title: "Last correction", action: nil, keyEquivalent: "")
        let sub = NSMenu()
        if lastReplacements.isEmpty {
            let none = NSMenuItem(title: lastSummary ?? "(none yet)", action: nil, keyEquivalent: "")
            none.isEnabled = false
            sub.addItem(none)
        } else {
            for r in lastReplacements {
                let item = NSMenuItem(title: r.label, action: #selector(copyReplacement(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = r.replacement
                item.toolTip = r.reason.map { "\($0)\(r.confidence.map { String(format: ", %.2f", $0) } ?? "")" }
                sub.addItem(item)
            }
        }
        last.submenu = sub
        menu.addItem(last)

        menu.addItem(.separator())
        add("Open lexicon file", #selector(openLexiconFile), enabled: available)
        add("Stats\u{2026}", #selector(showStats), enabled: available)
        add("Run doctor", #selector(runDoctor), enabled: available)

        menu.addItem(.separator())
        if Notifier.isBundled {
            let login = add("Start at login", #selector(toggleStartAtLogin), enabled: true)
            login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        }
        add("Preferences\u{2026}", #selector(openPreferences), enabled: true, key: ",")

        if let lastError {
            menu.addItem(.separator())
            addInfo("Last error: \(lastError)")
        }

        menu.addItem(.separator())
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        add("Quit LexiconBar\(version.map { " \($0)" } ?? "")", #selector(quit), enabled: true, key: "q")
    }

    @discardableResult
    private func add(_ title: String, _ action: Selector, enabled: Bool, key: String = "", indent: Int = 0) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.isEnabled = enabled
        item.indentationLevel = indent
        menu.addItem(item)
        return item
    }

    private func addInfo(_ title: String, indent: Int = 0) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        item.indentationLevel = indent
        // Long messages wrap badly in menus; trim.
        if title.count > 90 { item.title = String(title.prefix(87)) + "\u{2026}" }
        item.toolTip = title
        menu.addItem(item)
    }

    private func updateStatusIcon() {
        guard let button = statusItem?.button else { return }
        let name: String
        switch voiceState {
        case .idle, .fixingClipboard: name = "waveform"
        case .recording: name = "waveform.badge.mic"
        case .transcribing: name = "waveform.badge.magnifyingglass"
        }
        let image = NSImage(systemSymbolName: name, accessibilityDescription: "LexiconBar")
            ?? NSImage(systemSymbolName: "waveform", accessibilityDescription: "LexiconBar")
        image?.isTemplate = true
        button.image = image
        button.contentTintColor = voiceState == .recording ? .systemRed : nil
        button.toolTip = voiceState == .recording ? "LexiconBar: recording" : "LexiconBar"
        button.appearsDisabled = !cli.isAvailable
    }

    // MARK: hotkeys

    private func registerHotKeys() {
        if let id = pushToTalkHotKeyID { hotKeys.unregister(id) }
        if let id = fixClipboardHotKeyID { hotKeys.unregister(id) }
        pushToTalkHotKeyID = hotKeys.register(settings.pushToTalkHotKey) { [weak self] in self?.togglePushToTalk() }
        fixClipboardHotKeyID = hotKeys.register(settings.fixClipboardHotKey) { [weak self] in self?.fixClipboardNow() }
        if pushToTalkHotKeyID == nil {
            lastError = "Could not register \(settings.pushToTalkHotKey.displayString); another app may own it."
        }
    }

    // MARK: voice

    private var voiceArguments: [String] {
        var args = ["voice", "--toggle", "--json", "--model", settings.model]
        if settings.pasteMode { args.append("--paste") }
        return args
    }

    @objc private func togglePushToTalk() {
        guard cli.isAvailable else { openPreferences(); return }
        guard voiceState == .idle || voiceState == .recording else { return }
        let stopping = voiceState == .recording
        if stopping { voiceState = .transcribing }
        let pasteRequested = settings.pasteMode
        cli.run(voiceArguments, timeout: stopping ? LexiconCLI.voiceTimeout : LexiconCLI.defaultTimeout) { [weak self] result in
            guard let self else { return }
            if result.launchError != nil || result.timedOut {
                self.voiceState = .idle
                self.reportError(result.timedOut ? "Voice call timed out after \(Int(LexiconCLI.voiceTimeout)) s." : result.failureDescription)
                self.syncVoiceStatus()
                return
            }
            switch VoiceToggleOutcome.parse(stdout: result.stdout) {
            case .recording:
                self.voiceState = .recording
                self.lastError = nil
                self.startStatusPolling()
            case .finished(let voice):
                self.voiceState = .idle
                self.stopStatusPolling()
                self.remember(replacements: voice.replacements, summary: voice.summary)
                self.notify(summary: voice.summary, replacements: voice.replacements, model: voice.model, seconds: voice.seconds)
                if !pasteRequested {
                    // Copy mode: make sure the corrected text is on the clipboard.
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(voice.output, forType: .string)
                }
                if CLIOutput.indicatesPasteFailure(result: voice, stderr: result.stderr, exitCode: result.exitCode, pasteRequested: pasteRequested) {
                    self.showAccessibilityHintIfNeeded()
                }
            case .unrecognized(let text):
                self.voiceState = .idle
                self.stopStatusPolling()
                if result.exitCode != 0 {
                    self.reportError(result.failureDescription)
                    if CLIOutput.indicatesPasteFailure(result: nil, stderr: result.stderr, exitCode: result.exitCode, pasteRequested: pasteRequested) {
                        self.showAccessibilityHintIfNeeded()
                    }
                } else {
                    self.reportError("Unexpected voice output: \(text.prefix(200))")
                }
                self.syncVoiceStatus()
            }
        }
    }

    /// `lexicon voice --status`: exit 0 while recording, 1 when idle.
    private func syncVoiceStatus() {
        guard cli.isAvailable, !statusPollInFlight, voiceState != .transcribing else { return }
        statusPollInFlight = true
        cli.run(["voice", "--status"]) { [weak self] result in
            guard let self else { return }
            self.statusPollInFlight = false
            guard result.launchError == nil, !result.timedOut, self.voiceState != .transcribing else { return }
            let recording = result.exitCode == 0
            if recording, self.voiceState == .idle {
                self.voiceState = .recording
                self.startStatusPolling()
            } else if !recording, self.voiceState == .recording {
                self.voiceState = .idle
                self.stopStatusPolling()
            }
        }
    }

    private func startStatusPolling() {
        statusPollTimer?.invalidate()
        statusPollTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            DispatchQueue.main.async { self?.syncVoiceStatus() }
        }
    }

    private func stopStatusPolling() {
        statusPollTimer?.invalidate()
        statusPollTimer = nil
    }

    // MARK: clipboard

    @objc private func fixClipboardNow() {
        guard cli.isAvailable else { openPreferences(); return }
        guard voiceState == .idle else { return }
        voiceState = .fixingClipboard
        var args = ["daemon", "--once"]
        let pasteRequested = settings.pasteMode
        if pasteRequested { args.append("--paste") }
        cli.run(args) { [weak self] result in
            guard let self else { return }
            self.voiceState = .idle
            let parsed = ClipboardOnceResult.parse(stdout: result.stdout)
            if result.launchError != nil || result.timedOut {
                self.reportError(result.failureDescription)
                return
            }
            self.remember(replacements: parsed.replacements, summary: parsed.summary)
            self.notify(summary: parsed.summary, replacements: parsed.replacements, model: nil, seconds: nil)
            if CLIOutput.indicatesPasteFailure(result: nil, stderr: result.stderr, exitCode: result.exitCode, pasteRequested: pasteRequested) {
                self.showAccessibilityHintIfNeeded()
            } else if result.exitCode != 0 {
                self.reportError(result.failureDescription)
            }
        }
    }

    private func remember(replacements: [Replacement], summary: String) {
        lastReplacements = replacements
        lastSummary = summary
        lastError = nil
    }

    private func notify(summary: String, replacements: [Replacement], model: String?, seconds: Double?) {
        var body = replacements.prefix(4).map(\.label).joined(separator: "\n")
        if replacements.count > 4 { body += "\n\u{2026} and \(replacements.count - 4) more" }
        if body.isEmpty {
            var extra: [String] = []
            if let model { extra.append(model) }
            if let seconds { extra.append(String(format: "%.1f s of audio", seconds)) }
            body = extra.isEmpty ? "Nothing to fix." : extra.joined(separator: ", ")
        }
        notifier.post(title: summary, body: body)
    }

    @objc private func copyReplacement(_ sender: NSMenuItem) {
        guard let text = sender.representedObject as? String else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    // MARK: children

    @objc private func toggleWatchClipboard() {
        settings.watchClipboard.toggle()
        settings.watchClipboard ? daemon.start() : daemon.stop()
    }

    @objc private func toggleLocalAPI() {
        settings.localAPI.toggle()
        settings.localAPI ? server.start() : server.stop()
    }

    private func childStateChanged(name: String, state: ChildProcessSupervisor.State, setting: ReferenceWritableKeyPath<Settings, Bool>) {
        if case .failed(let why) = state {
            settings[keyPath: setting] = false
            reportError("\(name): \(why)")
            notifier.post(title: "\(name) stopped", body: why)
        }
    }

    @objc private func showAPIInfo() {
        cli.run(["serve", "--show"]) { [weak self] result in
            guard let self else { return }
            guard result.succeeded else { self.reportError(result.failureDescription); return }
            let text = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            let alert = NSAlert()
            alert.messageText = "Local API"
            alert.informativeText = text.isEmpty ? "http://127.0.0.1:41733" : text
            alert.addButton(withTitle: "Copy")
            alert.addButton(withTitle: "OK")
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(alert.informativeText, forType: .string)
            }
        }
    }

    // MARK: lexicon file, stats, doctor

    @objc private func openLexiconFile() {
        cli.run(["path"]) { [weak self] result in
            guard let self else { return }
            guard result.succeeded else { self.reportError(result.failureDescription); return }
            let paths = LexiconPaths.parse(stdout: result.stdout)
            guard let global = paths.global else {
                self.reportError("`lexicon path` printed no global path:\n\(result.stdout)")
                return
            }
            let url = URL(fileURLWithPath: global)
            if FileManager.default.fileExists(atPath: global) {
                if !NSWorkspace.shared.open(url) {
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                }
            } else {
                let alert = NSAlert()
                alert.messageText = "No lexicon file yet"
                alert.informativeText = "Expected at \(global). Run `lexicon add <term>` or `lexicon harvest` to create it."
                NSApp.activate(ignoringOtherApps: true)
                alert.runModal()
            }
        }
    }

    @objc private func showStats() {
        cli.run(["stats", "--json"]) { [weak self] result in
            guard let self else { return }
            guard result.succeeded else { self.reportError(result.failureDescription); return }
            let alert = NSAlert()
            alert.messageText = "Lexicon stats"
            if let stats = StatsSummary.parse(stdout: result.stdout), !stats.counts.isEmpty {
                alert.informativeText = stats.text
            } else {
                alert.informativeText = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
    }

    @objc private func runDoctor() {
        cli.run(["doctor"]) { [weak self] result in
            guard let self else { return }
            if let launchError = result.launchError { self.reportError(launchError); return }
            var text = result.stdout
            if !result.stderr.isEmpty { text += "\n\n[stderr]\n" + result.stderr }
            if result.timedOut { text += "\n\n(timed out after \(Int(LexiconCLI.defaultTimeout)) s)" }
            text += "\n\nexit code \(result.exitCode)"
            if self.doctorWindow == nil { self.doctorWindow = TextWindowController(title: "lexicon doctor") }
            self.doctorWindow?.show(text: text)
        }
    }

    // MARK: login item, preferences, quit

    @objc private func toggleStartAtLogin() {
        let service = SMAppService.mainApp
        do {
            if service.status == .enabled {
                try service.unregister()
            } else {
                try service.register()
            }
        } catch {
            reportError("Start at login: \(error.localizedDescription)")
        }
    }

    @objc private func openPreferences() {
        if preferencesWindow == nil {
            preferencesWindow = PreferencesWindowController(settings: settings, status: cliStatus)
        }
        preferencesWindow?.show()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }

    // MARK: errors and hints

    private func reportError(_ message: String) {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        lastError = trimmed
        NSLog("LexiconBar: %@", trimmed)
        notifier.post(title: "LexiconBar", body: String(trimmed.prefix(200)))
    }

    /// One-time pointer at the Accessibility pane. The CLI pastes through
    /// osascript, and macOS attributes that to LexiconBar.app as the
    /// responsible process, so it is this app that needs the permission.
    private func showAccessibilityHintIfNeeded() {
        guard !settings.accessibilityHintShown else {
            lastError = "Paste failed: LexiconBar needs Accessibility permission."
            return
        }
        settings.accessibilityHintShown = true
        let alert = NSAlert()
        alert.messageText = "Allow LexiconBar to paste"
        alert.informativeText = "The text was corrected and is on the clipboard, but pasting into the frontmost app failed. Add LexiconBar under System Settings > Privacy & Security > Accessibility, then try again."
        alert.addButton(withTitle: "Open System Settings")
        alert.addButton(withTitle: "Later")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn,
           let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }
}
