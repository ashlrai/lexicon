import AppKit
import Combine
import os
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

    /// Which of `updateStatusIcon`'s three drawing paths produced what is in
    /// the menu bar right now. Logged at launch.
    enum StatusIconSource: String {
        case symbol
        case drawn
        case title
    }

    private let settings = Settings()
    private let runner = CommandRunner()
    private lazy var cli = LexiconCLI(runner: runner)
    private let hotKeys = HotKeyCenter()
    private let notifier = Notifier()
    private let cliStatus = CLIStatusModel()

    private var statusItem: NSStatusItem!
    private var statusIconSource: StatusIconSource = .symbol
    private let menu = NSMenu()
    private var preferencesWindow: PreferencesWindowController?
    private var doctorWindow: TextWindowController?
    private var cancellables: Set<AnyCancellable> = []

    private var daemon: ChildProcessSupervisor!
    private var server: ChildProcessSupervisor!
    /// Who actually runs `lexicon serve`: a LaunchAgent, our own child, a
    /// stranger on the port, or nobody. Drives the menu row, the onboarding
    /// row, and whether we are allowed to start a child at all.
    private lazy var serveOwnership = ServeOwnershipMonitor(runner: runner, credentials: normalizeClient)
    /// True while `lexicon serve --install` is in flight, so a second sync
    /// does not kick off a second install.
    private var installingLaunchAgent = false

    // Fix everywhere: one AX thread shared by the watcher and the engine.
    private let axThread = AXThread()
    private lazy var focusWatcher = FocusWatcher(ax: axThread)
    // One credential loader for the whole app: the engine's `/normalize` and
    // the onboarding window's `/add`, `/aliases` and `/packs` share its cache
    // and its invalidation, so a re-issued token heals everywhere at once.
    private let normalizeClient = NormalizeClient()
    private lazy var localAPI = LocalAPI(credentials: normalizeClient)
    private lazy var fixEngine = FixEngine(ax: axThread, watcher: focusWatcher, client: normalizeClient)
    private lazy var bubble = CorrectionBubbleController()
    private var onboardingWindow: OnboardingWindowController?
    private var undoFixHotKeyID: UInt32?
    private var undoAvailable = false
    private var fixFlashTimer: Timer?
    private var fixFlashing = false { didSet { updateStatusIcon() } }
    private var accessibilityTrusted = AX.isTrusted
    /// Rate limit on the state file (see `writeAccessibilityState`).
    private var accessibilityStateThrottle = AccessibilityStateThrottle()
    private var accessibilityStateTimer: Timer?
    private var sigtermSource: DispatchSourceSignal?

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
        server.onStateChange = { [weak self] state in
            self?.childStateChanged(name: "Local API", state: state, setting: \.localAPI)
            // Our child starting or stopping changes who owns the port.
            self?.serveOwnership.refreshIfStale(force: true)
        }

        cliStatus.redetect = { [weak self] in self?.detectCLI() }
        serveOwnership.onChange = { [weak self] in
            guard let self else { return }
            self.rebuildMenu()
            self.onboardingWindow?.model.serveStatus = self.serveStatus()
        }
        serveOwnership.refreshIfStale(force: true)
        settings.$pushToTalkHotKey.dropFirst().sink { [weak self] _ in self?.registerHotKeys() }.store(in: &cancellables)
        settings.$fixClipboardHotKey.dropFirst().sink { [weak self] _ in self?.registerHotKeys() }.store(in: &cancellables)
        // The onboarding window's step 4 writes these settings directly, so
        // the children follow the setting rather than the menu item that used
        // to be the only way to change it.
        settings.$watchClipboard.dropFirst().sink { [weak self] _ in
            DispatchQueue.main.async { self?.syncChildProcesses() }
        }.store(in: &cancellables)
        settings.$localAPI.dropFirst().sink { [weak self] _ in
            DispatchQueue.main.async { self?.syncChildProcesses() }
        }.store(in: &cancellables)

        registerHotKeys()
        detectCLI()
        installTerminationHandler()
        startFixEverywhere()
        bubble.onAction = { [weak self] action, line in self?.bubbleAction(action, line: line) }
        // First launch, or `--onboard` on any launch. Deferred a beat so the
        // status item is in the menu bar before the window covers it.
        if CommandLine.arguments.contains("--onboard") || !settings.didOnboard {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.openOnboarding() }
        }
        // `ax=` is the app's own view of the Accessibility grant, from the
        // process the user actually launched — the one answer a `--status` run
        // from a terminal cannot give, because TCC attributes that check to
        // the terminal instead.
        let shortVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
        AppDelegate.log.notice("LexiconBar \(shortVersion, privacy: .public) launched: status item visible=\(self.statusItem.isVisible, privacy: .public), bundled=\(Notifier.isBundled, privacy: .public), ax=\(self.accessibilityTrusted, privacy: .public), push-to-talk=\(self.settings.pushToTalkHotKey.displayString, privacy: .public)")
        // Which drawing path the menu bar icon took, and whether anything is
        // actually in it. Once now and once after AppKit has laid the button
        // out, since only the second call sees a real frame.
        logStatusItem("launch")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.logStatusItem("settled") }
    }

    /// Turns SIGTERM into a normal quit.
    ///
    /// AppKit runs `applicationWillTerminate` for the Quit menu item but not
    /// for a signal, so `kill` and a logout used to take the app down without
    /// any of its cleanup: the `lexicon daemon` and `lexicon serve` children
    /// outlived it, and the Accessibility state file was left claiming the
    /// app was still up until it aged out five minutes later. Ignoring the
    /// default disposition and handling it on the main queue routes both
    /// cases through the same path the menu item uses.
    private func installTerminationHandler() {
        signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { NSApp.terminate(nil) }
        source.resume()
        sigtermSource = source
    }

    func applicationWillTerminate(_ notification: Notification) {
        bubble.dismiss()
        statusPollTimer?.invalidate()
        fixFlashTimer?.invalidate()
        focusWatcher.stop()
        accessibilityStateTimer?.invalidate()
        // The watcher has stopped, so the last record says so: a `--status`
        // run a second later reports the app as gone rather than waiting out
        // the five-minute staleness window with a stale "trusted".
        writeAccessibilityState(force: true, running: false)
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
                self.syncLocalAPI()
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
        addFixEverywhereItems()

        menu.addItem(.separator())

        let watch = add("Watch clipboard", #selector(toggleWatchClipboard), enabled: available)
        watch.state = daemon?.isRunning == true ? .on : (settings.watchClipboard && available ? .mixed : .off)
        addLocalAPIItems(available: available)
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
        let setup = add("Set up Lexicon\u{2026}", #selector(openOnboarding), enabled: true)
        setup.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: nil)
        setup.toolTip = "The first-run walkthrough: your words, starter packs and where corrections happen."
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

    /// The "Local API" row. What it looks like depends on who owns the port:
    /// a checkbox when this app could start or stop the server, a plain status
    /// line (plus how to manage it) when a LaunchAgent or a stranger holds it,
    /// so a click can never start a second server that fails to bind.
    private func addLocalAPIItems(available: Bool) {
        // Cheap while the cache is warm; reports back through `onChange`.
        serveOwnership.refreshIfStale()
        let serve = serveStatus()
        if serve.isInteractive {
            let api = add(serve.title, #selector(toggleLocalAPI), enabled: available)
            api.state = serve.isOn ? .on : (settings.localAPI && available ? .mixed : .off)
            api.toolTip = serve.detail
        } else {
            addInfo(serve.title)
            if let hint = serve.hint { addInfo(hint, indent: 1) }
        }
        if serve.isOn {
            add("Show API URL and token\u{2026}", #selector(showAPIInfo), enabled: available, indent: 1)
        }
    }

    /// "Fix everywhere" block: master switch, per-app switch for the app that
    /// was frontmost when the menu opened, undo, and a permission pointer.
    private func addFixEverywhereItems() {
        let master = add("Fix everywhere", #selector(toggleFixEverywhere), enabled: true)
        master.state = settings.fixEverywhere ? .on : .off
        master.toolTip = "Correct dictated text in the focused field of any app, about a second after it lands."
        if let app = focusWatcher.frontmostApp, let bundleID = app.bundleID {
            let excluded = settings.exclusions.isExcluded(bundleID)
            let item = add("Fix everywhere in \(app.name)", #selector(toggleFixEverywhereForFrontmostApp), enabled: settings.fixEverywhere, indent: 1)
            item.state = excluded ? .off : .on
            item.representedObject = bundleID
            item.toolTip = bundleID
        }
        let undo = add("Undo last fix (\(settings.undoFixHotKey.displayString))", #selector(undoLastFix), enabled: settings.fixEverywhere && undoAvailable, indent: 1)
        undo.toolTip = "Puts the dictated text back if the field still holds the corrected text."
        let showBubble = add("Show the correction bubble", #selector(toggleShowBubble), enabled: settings.fixEverywhere, indent: 1)
        showBubble.state = settings.showBubble ? .on : .off
        showBubble.toolTip = "A small panel near the caret after each fix, with Undo, Never and Add. Off falls back to a notification."
        if settings.fixEverywhere, !accessibilityTrusted {
            let hint = add("Needs Accessibility permission \u{2013} open System Settings", #selector(openAccessibilitySettings), enabled: true, indent: 1)
            hint.image = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: nil)
        }
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

    /// Draws the status item, and guarantees it is never blank.
    ///
    /// Three paths, tried in order: the SF Symbol for the current state, a
    /// waveform drawn by hand if that symbol name is missing on this macOS,
    /// and a short text title if even that produces nothing. A menu bar app
    /// that draws nothing is worse than one that crashes, because the user has
    /// no way to find it and concludes the install failed. `statusIconSource`
    /// records which path ran; `logStatusItem` prints it at launch.
    private func updateStatusIcon() {
        guard let button = statusItem?.button else { return }
        let name: String
        switch voiceState {
        case .idle, .fixingClipboard: name = "waveform"
        case .recording: name = "waveform.badge.mic"
        case .transcribing: name = "waveform.badge.magnifyingglass"
        }
        var source = StatusIconSource.symbol
        var image = NSImage(systemSymbolName: name, accessibilityDescription: "LexiconBar")
            ?? NSImage(systemSymbolName: "waveform", accessibilityDescription: "LexiconBar")
        if image == nil {
            image = AppDelegate.drawnWaveform()
            source = .drawn
        }
        if fixFlashing, let base = image { image = AppDelegate.badged(base) }
        image?.isTemplate = true
        // A zero-sized image is as invisible as no image at all, so it counts
        // as a failure here rather than being handed to the button.
        if let image, image.size.width > 0, image.size.height > 0 {
            button.image = image
            button.title = ""
            button.imagePosition = .imageOnly
        } else {
            button.image = nil
            button.title = AppDelegate.fallbackTitle
            button.imagePosition = .noImage
            source = .title
        }
        statusIconSource = source
        statusItem.isVisible = true
        button.contentTintColor = voiceState == .recording ? .systemRed : nil
        button.toolTip = voiceState == .recording ? "LexiconBar: recording" : "LexiconBar"
        button.appearsDisabled = !cli.isAvailable
    }

    /// The last resort: what the button says when no image can be produced.
    /// Two letters, because the menu bar charges by the point.
    private static let fallbackTitle = "LB"

    /// `os.Logger` rather than `NSLog`, because NSLog hands the unified log one
    /// already-formatted string and the log then redacts the whole line as
    /// `<private>`. These lines exist to be read back off a user's machine with
    /// `log show --predicate 'subsystem == "ai.ashlr.lexiconbar"'`, so every
    /// field is marked public deliberately. Nothing here is personal: it is
    /// geometry and a symbol name.
    static let log = Logger(subsystem: "ai.ashlr.lexiconbar", category: "statusitem")

    /// A waveform drawn by hand, for the case where the SF Symbol is missing
    /// (a renamed or withdrawn symbol on some future macOS). Five rounded
    /// bars, template so the menu bar tints it for light and dark exactly as
    /// it tints the real symbol.
    private static func drawnWaveform() -> NSImage {
        let size = NSSize(width: 16, height: 16)
        let image = NSImage(size: size, flipped: false) { _ in
            let heights: [CGFloat] = [4, 9, 14, 9, 4]
            let barWidth: CGFloat = 1.6
            let gap = (size.width - CGFloat(heights.count) * barWidth) / CGFloat(heights.count + 1)
            NSColor.black.setFill()
            for (index, height) in heights.enumerated() {
                let x = gap + CGFloat(index) * (barWidth + gap)
                let bar = NSRect(x: x, y: (size.height - height) / 2, width: barWidth, height: height)
                NSBezierPath(roundedRect: bar, xRadius: barWidth / 2, yRadius: barWidth / 2).fill()
            }
            return true
        }
        image.isTemplate = true
        return image
    }

    /// Reports what the status item actually became, and repairs it if it
    /// somehow came out empty anyway.
    ///
    /// Run once at launch and once a beat later, after AppKit has laid the
    /// button out: only the second call sees a real frame. "I installed it and
    /// nothing appeared" is answerable from this line alone, which is why it is
    /// logged on every launch rather than behind a debug flag.
    private func logStatusItem(_ when: String) {
        guard let button = statusItem?.button else {
            AppDelegate.log.error("status item (\(when, privacy: .public)): NO BUTTON")
            return
        }
        let hasContent = button.image != nil || !button.title.isEmpty
        let frame = NSStringFromRect(button.frame)
        AppDelegate.log.notice("status item (\(when, privacy: .public)): source=\(self.statusIconSource.rawValue, privacy: .public) image=\(button.image != nil, privacy: .public) title=\"\(button.title, privacy: .public)\" visible=\(self.statusItem.isVisible, privacy: .public) length=\(self.statusItem.length, privacy: .public) frame=\(frame, privacy: .public) \(hasContent ? "ok" : "BLANK", privacy: .public)")
        guard !hasContent else { return }
        button.image = nil
        button.title = AppDelegate.fallbackTitle
        button.imagePosition = .noImage
        statusIconSource = .title
        statusItem.isVisible = true
        AppDelegate.log.error("status item (\(when, privacy: .public)): was blank, fell back to the title \"\(AppDelegate.fallbackTitle, privacy: .public)\"")
    }

    /// The status symbol with a small dot at the bottom right: "just fixed something".
    private static func badged(_ symbol: NSImage) -> NSImage {
        let size = NSSize(width: symbol.size.width + 4, height: symbol.size.height)
        let image = NSImage(size: size, flipped: false) { rect in
            symbol.draw(in: NSRect(x: 0, y: 0, width: symbol.size.width, height: symbol.size.height))
            let d: CGFloat = 5
            NSColor.black.setFill()
            NSBezierPath(ovalIn: NSRect(x: rect.maxX - d, y: 0, width: d, height: d)).fill()
            return true
        }
        image.isTemplate = true
        return image
    }

    // MARK: Fix everywhere

    private func startFixEverywhere() {
        fixEngine.onEvent = { [weak self] event in self?.handleFixEvent(event) }
        pushFixConfig()
        focusWatcher.start()
        // The watcher is up: publish what this process — the one the user
        // actually launched — sees, and keep republishing it so a reader can
        // tell a running app from a dead one.
        writeAccessibilityState(force: true)
        accessibilityStateTimer = Timer.scheduledTimer(withTimeInterval: AccessibilityStateStore.heartbeat,
                                                       repeats: true) { [weak self] _ in
            DispatchQueue.main.async { self?.writeAccessibilityState() }
        }
        for publisher in [settings.$fixEverywhere.dropFirst().map { _ in () }.eraseToAnyPublisher(),
                          settings.$fixSettleMs.dropFirst().map { _ in () }.eraseToAnyPublisher(),
                          settings.$fixMinWords.dropFirst().map { _ in () }.eraseToAnyPublisher(),
                          settings.$fixExcludedApps.dropFirst().map { _ in () }.eraseToAnyPublisher()] {
            publisher.sink { [weak self] in self?.pushFixConfig() }.store(in: &cancellables)
        }
        settings.$undoFixHotKey.dropFirst().sink { [weak self] _ in self?.registerHotKeys() }.store(in: &cancellables)
        if settings.fixEverywhere, !accessibilityTrusted {
            // Deliberately no system prompt here. Launching is not the user asking for one, and
            // an ad-hoc signature is revoked by every rebuild, so prompting on launch means a
            // dialog after every update. The menu and the onboarding window show the state, and
            // "Grant Accessibility" there is the one place that asks. We just watch for the grant.
            NSLog("LexiconBar: accessibility not granted; Fix everywhere is idle (menu: Set up Lexicon…)")
            Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] timer in
                DispatchQueue.main.async {
                    guard let self else { timer.invalidate(); return }
                    if AX.isTrusted {
                        self.accessibilityTrusted = true
                        timer.invalidate()
                        self.writeAccessibilityState(force: true)
                        NSLog("LexiconBar: Accessibility granted")
                    }
                }
            }
        }
    }

    private func pushFixConfig() {
        var config = FixEngine.Config()
        config.enabled = settings.fixEverywhere
        config.settleMs = Int(settings.fixSettleMs)
        config.minWords = settings.fixMinWords
        config.exclusions = settings.exclusions
        fixEngine.update(config)
    }

    private func handleFixEvent(_ event: FixEngine.Event) {
        switch event {
        case .fixed(let fix):
            remember(replacements: fix.replacements, summary: fix.summary)
            flashStatusIcon()
            NSLog("LexiconBar fix: %@ in %@ via %@ in %d ms", fix.replacements.map(\.label).joined(separator: ", "), fix.appName, fix.strategy, fix.elapsedMs)
            // The bubble is the visible channel; the notification is the
            // fallback for when the user has turned the bubble off.
            if settings.showBubble, let content = CorrectionBubble.content(for: fix.replacements) {
                bubble.show(content, caret: fix.caret, seconds: settings.bubbleSeconds)
            } else if settings.fixNotify {
                let labels = fix.replacements.prefix(3).map(\.label).joined(separator: ", ")
                let more = fix.replacements.count > 3 ? " +\(fix.replacements.count - 3)" : ""
                notifier.post(title: "Fixed: \(labels)\(more)", body: "in \(fix.appName). \(settings.undoFixHotKey.displayString) undoes it.")
            }
        case .undone(let appName):
            lastError = nil
            bubble.dismiss()
            if settings.fixNotify { notifier.post(title: "Undid the last fix", body: "in \(appName)") }
        case .skipped(let why):
            lastError = why
        case .failed(let why):
            // Logged by the engine; shown in the menu, never as a notification
            // (a stopped `lexicon serve` would otherwise nag on every burst).
            lastError = why
        case .undoAvailable(let available):
            undoAvailable = available
        }
    }

    private func flashStatusIcon() {
        fixFlashing = true
        fixFlashTimer?.invalidate()
        fixFlashTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { [weak self] _ in
            DispatchQueue.main.async { self?.fixFlashing = false }
        }
    }

    @objc private func toggleFixEverywhere() {
        settings.fixEverywhere.toggle()
        if settings.fixEverywhere, !AX.isTrusted { AX.requestTrust() }
        if !settings.fixEverywhere { bubble.dismiss() }
        accessibilityTrusted = AX.isTrusted
        writeAccessibilityState(force: true)
    }

    /// Publishes this process's Accessibility answer to
    /// `~/Library/Application Support/LexiconBar/state.json`.
    ///
    /// `AXIsProcessTrusted()` is only meaningful in the process the window
    /// server launched, and a terminal cannot ask that process anything. So
    /// the app writes the answer down: on launch, when the focus watcher
    /// starts or stops, when the grant changes under it, and otherwise once
    /// every `AccessibilityStateStore.heartbeat` seconds, which is also what
    /// lets a reader tell "running and denied" from "not running at all".
    /// `--status` reads it; nothing else depends on it, so a failed write is
    /// logged and dropped.
    private func writeAccessibilityState(force: Bool = false, running: Bool = true) {
        let trusted = AX.isTrusted
        if running { accessibilityTrusted = trusted }
        let now = Date()
        guard accessibilityStateThrottle.shouldWrite(trusted: trusted, now: now, force: force) else { return }
        let state = AccessibilityState(
            axTrusted: trusted,
            pid: ProcessInfo.processInfo.processIdentifier,
            updatedAt: now,
            running: running,
            version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String)
        do {
            try AccessibilityStateStore.write(state)
        } catch {
            NSLog("LexiconBar: could not write %@: %@",
                  AccessibilityStateStore.displayPath(), error.localizedDescription)
        }
    }

    @objc private func toggleShowBubble() {
        settings.showBubble.toggle()
        if !settings.showBubble { bubble.dismiss() }
    }

    /// One of the three buttons on the correction bubble. `line` is the
    /// replacement the bubble said the button applies to.
    private func bubbleAction(_ action: BubbleAction, line: BubbleLine) {
        switch action {
        case .undo:
            fixEngine.undoLast()
        case .never:
            // Record the original under the term's `never` list, then put the
            // text back. The undo runs regardless of what the API says, so a
            // stopped `lexicon serve` still gives the user their word back.
            localAPI.add(canonical: line.canonical, never: [line.original]) { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if case .failure(let why) = result {
                        self.reportError("Could not record \u{201C}\(line.original)\u{201D} as never: \(why.description)")
                    } else {
                        self.notifier.post(title: "Left alone from now on",
                                           body: "\u{201C}\(line.original)\u{201D} will not be corrected to \u{201C}\(line.canonical)\u{201D}.")
                    }
                }
            }
            fixEngine.undoLast()
        case .add:
            localAPI.learn(heard: line.original, meant: line.canonical) { [weak self] result in
                DispatchQueue.main.async {
                    guard let self else { return }
                    switch result {
                    case .success:
                        self.notifier.post(title: "Learned it",
                                           body: "\u{201C}\(line.original)\u{201D} now maps to \u{201C}\(line.canonical)\u{201D} exactly.")
                    case .failure(let why):
                        self.reportError("Could not learn \u{201C}\(line.original)\u{201D}: \(why.description)")
                    }
                }
            }
        }
    }

    @objc private func toggleFixEverywhereForFrontmostApp(_ sender: NSMenuItem) {
        guard let bundleID = sender.representedObject as? String else { return }
        var exclusions = settings.exclusions
        if exclusions.isExcluded(bundleID) { exclusions.include(bundleID) } else { exclusions.exclude(bundleID) }
        settings.exclusions = exclusions
    }

    @objc private func undoLastFix() {
        guard settings.fixEverywhere else { return }
        fixEngine.undoLast()
    }

    @objc private func openAccessibilitySettings() {
        AX.requestTrust()
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
    }

    // MARK: hotkeys

    private func registerHotKeys() {
        if let id = pushToTalkHotKeyID { hotKeys.unregister(id) }
        if let id = fixClipboardHotKeyID { hotKeys.unregister(id) }
        if let id = undoFixHotKeyID { hotKeys.unregister(id) }
        pushToTalkHotKeyID = hotKeys.register(settings.pushToTalkHotKey) { [weak self] in self?.togglePushToTalk() }
        fixClipboardHotKeyID = hotKeys.register(settings.fixClipboardHotKey) { [weak self] in self?.fixClipboardNow() }
        undoFixHotKeyID = hotKeys.register(settings.undoFixHotKey) { [weak self] in self?.undoLastFix() }
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

    /// The current answer from the ownership monitor, with this app's own
    /// supervisor state folded in.
    private func serveStatus() -> ServeStatus {
        serveOwnership.status(appChildRunning: server?.isRunning == true)
    }

    /// Flips the *wish*; `syncLocalAPI` decides how to honour it. Does nothing
    /// when the row is a status line — a LaunchAgent or a stranger owns the
    /// port and this app has no business touching it.
    @objc private func toggleLocalAPI() {
        guard serveStatus().isInteractive else { return }
        settings.localAPI.toggle()
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

    /// The first-run walkthrough. Shown automatically once, on `--onboard`,
    /// and from the menu. `didOnboard` is set when the flow reaches the end,
    /// not when the window opens, so closing it halfway brings it back next
    /// launch.
    @objc private func openOnboarding() {
        if onboardingWindow == nil {
            let model = OnboardingModel(settings: settings, api: localAPI)
            model.openLexiconFile = { [weak self] in self?.openLexiconFile() }
            model.onFinish = { [weak self] in
                guard let self else { return }
                self.settings.didOnboard = true
                // The steps write settings directly; make sure the children
                // and the menu catch up with what the user chose.
                self.syncChildProcesses()
                self.rebuildMenu()
            }
            // Step 4's local-API row reads the same resolver as the menu, so
            // the two can never disagree about who runs the server.
            model.serveStatus = serveStatus()
            model.refreshServeStatus = { [weak self] in
                guard let self else { return }
                self.serveOwnership.whenFresh(force: true) { [weak self] in
                    guard let self else { return }
                    self.onboardingWindow?.model.serveStatus = self.serveStatus()
                }
            }
            onboardingWindow = OnboardingWindowController(model: model)
        }
        onboardingWindow?.model.serveStatus = serveStatus()
        bubble.dismiss()
        onboardingWindow?.show()
    }

    /// Starts or stops the `daemon` and `serve` children to match the
    /// settings, after something other than the menu changed them.
    private func syncChildProcesses() {
        guard cli.isAvailable else { return }
        if settings.watchClipboard, daemon?.isRunning != true { daemon?.start() }
        if !settings.watchClipboard, daemon?.isRunning == true { daemon?.stop() }
        syncLocalAPI()
    }

    /// Makes the world match `settings.localAPI`, without ever starting a
    /// second server. The probe is re-run first when it has gone stale, because
    /// the decision turns on who owns the port right now.
    private func syncLocalAPI() {
        guard cli.isAvailable else { return }
        serveOwnership.whenFresh { [weak self] in self?.applyLocalAPIWish() }
    }

    private func applyLocalAPIWish() {
        guard cli.isAvailable else { return }
        let serve = serveStatus()
        guard settings.localAPI else {
            if server?.isRunning == true { server?.stop() }
            return
        }
        switch serve.ownership {
        case .launchAgent, .foreign:
            // Someone else holds the port. Our child could only fail to bind.
            if server?.isRunning == true { server?.stop() }
        case .appChild:
            break
        case .none:
            startLocalAPI()
        }
    }

    /// Starting the API prefers the LaunchAgent over a child of ours: it
    /// survives an app restart, a logout and a crash, which is what the user
    /// asking for "the local API" almost always means. The supervised child is
    /// the fallback when the install will not go through, and the reason is
    /// surfaced rather than swallowed.
    private func startLocalAPI() {
        guard !installingLaunchAgent, server?.isRunning != true else { return }
        installingLaunchAgent = true
        cli.run(["serve", "--install"], timeout: 30) { [weak self] result in
            guard let self else { return }
            self.installingLaunchAgent = false
            guard self.settings.localAPI else { return }
            if result.succeeded {
                NSLog("LexiconBar: installed the lexicon serve LaunchAgent")
                self.serveOwnership.whenFresh(force: true) { [weak self] in
                    guard let self else { return }
                    self.rebuildMenu()
                    self.onboardingWindow?.model.serveStatus = self.serveStatus()
                    // Nothing came up under launchd after all: keep the promise
                    // with a supervised child instead of leaving it off.
                    if !self.serveStatus().isOn, self.server?.isRunning != true { self.server?.start() }
                }
                return
            }
            self.reportError("Could not install the local API at login (\(result.failureDescription)). Running it under the app instead. It will stop when LexiconBar quits.")
            self.server?.start()
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
