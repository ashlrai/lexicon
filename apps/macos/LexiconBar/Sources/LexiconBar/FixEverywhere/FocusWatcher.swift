import AppKit
import ApplicationServices

/// Follows the frontmost app and its focused text field through the
/// Accessibility API. One `AXObserver` per app pid receives
/// `kAXFocusedUIElementChanged` (on the application element) and
/// `kAXValueChanged` (on the application element and again on the focused
/// element, since apps differ in where they post it). A 500 ms poll on the
/// AX thread covers apps that post neither reliably (some Electron builds).
///
/// Callbacks run on the AX thread. `frontmostApp` is main-thread state for the menu.
final class FocusWatcher: @unchecked Sendable {
    struct Field: Equatable {
        let element: AXUIElement
        let pid: pid_t
        let bundleID: String?
        let appName: String
        /// `AX.key` of the element; used for rate limits and undo.
        let key: String

        static func == (a: Field, b: Field) -> Bool { a.key == b.key && CFEqual(a.element, b.element) }
    }

    struct FrontmostApp: Equatable {
        let pid: pid_t
        let bundleID: String?
        let name: String
    }

    /// Called with the new focused field (or nil) and its current value.
    var onFieldChanged: ((Field?, String) -> Void)?
    /// Called on every observed or polled value change of the focused field.
    var onValueChanged: ((Field, String) -> Void)?

    /// The last activated app other than LexiconBar; main thread only.
    @MainActor private(set) var frontmostApp: FrontmostApp?

    private let ax: AXThread
    private var observers: [pid_t: AXObserver] = [:]
    private var observedElements: [pid_t: AXUIElement] = [:]
    private var activeApp: FrontmostApp?
    private var current: Field?
    private var lastValue: String = ""
    private var pollTimer: DispatchSourceTimer?
    private var workspaceTokens: [NSObjectProtocol] = []
    private var running = false
    private var ownPID = ProcessInfo.processInfo.processIdentifier

    init(ax: AXThread) {
        self.ax = ax
    }

    // MARK: lifecycle (main)

    @MainActor
    func start() {
        guard workspaceTokens.isEmpty else { return }
        let center = NSWorkspace.shared.notificationCenter
        workspaceTokens.append(center.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            MainActor.assumeIsolated { self?.activated(app) }
        })
        workspaceTokens.append(center.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
            let pid = app.processIdentifier
            self?.ax.async { self?.forget(pid: pid) }
        })
        ax.async { [self] in
            running = true
            AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 2.0)
            startPolling()
        }
        if let app = NSWorkspace.shared.frontmostApplication { activated(app) }
    }

    @MainActor
    func stop() {
        for token in workspaceTokens { NSWorkspace.shared.notificationCenter.removeObserver(token) }
        workspaceTokens = []
        ax.async { [self] in
            running = false
            pollTimer?.cancel()
            pollTimer = nil
            for pid in Array(observers.keys) { forget(pid: pid) }
            setCurrent(nil, value: "")
        }
    }

    @MainActor
    private func activated(_ app: NSRunningApplication) {
        let pid = app.processIdentifier
        let info = FrontmostApp(pid: pid, bundleID: app.bundleIdentifier, name: app.localizedName ?? app.bundleIdentifier ?? "pid \(pid)")
        if pid != ownPID { frontmostApp = info }
        ax.async { [self] in activate(info) }
    }

    // MARK: AX thread

    private func activate(_ app: FrontmostApp) {
        activeApp = app
        guard app.pid != ownPID else { setCurrent(nil, value: ""); return }
        ensureObserver(for: app.pid)
        refreshFocus(pid: app.pid)
    }

    private func ensureObserver(for pid: pid_t) {
        guard observers[pid] == nil else { return }
        var observer: AXObserver?
        let err = AXObserverCreate(pid, { _, element, notification, refcon in
            guard let refcon else { return }
            let watcher = Unmanaged<FocusWatcher>.fromOpaque(refcon).takeUnretainedValue()
            watcher.handle(notification: notification as String, element: element)
        }, &observer)
        guard err == .success, let observer else {
            NSLog("LexiconBar: AXObserverCreate(%d) failed (%d)", pid, err.rawValue)
            return
        }
        let appElement = AXUIElementCreateApplication(pid)
        // Electron/Chromium build their AX tree only once an assistive client
        // asks for it; this attribute is their documented switch.
        AX.set(appElement, "AXManualAccessibility", bool: true)
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        var registered = 0
        for name in [kAXFocusedUIElementChangedNotification, kAXValueChangedNotification, kAXFocusedWindowChangedNotification] {
            let status = AXObserverAddNotification(observer, appElement, name as CFString, refcon)
            if status == .success || status == .notificationAlreadyRegistered {
                registered += 1
            } else {
                NSLog("LexiconBar: AXObserverAddNotification %@ for pid %d: %d", name as String, pid, status.rawValue)
            }
        }
        // An app that is napping or still building its AX tree answers
        // kAXErrorCannotComplete; leave it unregistered so the next activation
        // tries again (the 500 ms poll covers the field meanwhile).
        guard registered > 0 else { return }
        ax.add(AXObserverGetRunLoopSource(observer))
        observers[pid] = observer
    }

    private func forget(pid: pid_t) {
        if let observer = observers.removeValue(forKey: pid) {
            ax.remove(AXObserverGetRunLoopSource(observer))
        }
        observedElements[pid] = nil
        if current?.pid == pid { setCurrent(nil, value: "") }
    }

    private func handle(notification: String, element: AXUIElement) {
        guard running, let pid = AX.pid(of: element), pid == activeApp?.pid else { return }
        switch notification {
        case kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification:
            refreshFocus(pid: pid)
        case kAXValueChangedNotification:
            // App-level value notifications arrive for any element in the app;
            // whichever element posted it, the focused field is re-read and an
            // unchanged value is dropped in `readValue`.
            guard let current else { return }
            readValue(of: current)
        default:
            break
        }
    }

    private func refreshFocus(pid: pid_t) {
        let appElement = AXUIElementCreateApplication(pid)
        guard let focused = AX.element(appElement, kAXFocusedUIElementAttribute as String) else {
            setCurrent(nil, value: "")
            return
        }
        if let current, CFEqual(current.element, focused) { return }
        guard AX.isEditableText(focused) else {
            setCurrent(nil, value: "")
            return
        }
        let field = Field(element: focused, pid: pid, bundleID: activeApp?.bundleID, appName: activeApp?.name ?? "",
                          key: AX.key(focused, pid: pid))
        observe(element: focused, pid: pid)
        setCurrent(field, value: AX.value(focused) ?? "")
    }

    /// Adds the value notification on the focused element itself (some apps
    /// only post it there) and drops it from the previously focused one.
    private func observe(element: AXUIElement, pid: pid_t) {
        guard let observer = observers[pid] else { return }
        let refcon = Unmanaged.passUnretained(self).toOpaque()
        if let previous = observedElements[pid], !CFEqual(previous, element) {
            AXObserverRemoveNotification(observer, previous, kAXValueChangedNotification as CFString)
        }
        AXObserverAddNotification(observer, element, kAXValueChangedNotification as CFString, refcon)
        observedElements[pid] = element
    }

    private func setCurrent(_ field: Field?, value: String) {
        if field == nil, current == nil { return }
        current = field
        lastValue = value
        onFieldChanged?(field, value)
    }

    private func readValue(of field: Field) {
        guard let value = AX.value(field.element) else { return }
        guard value != lastValue else { return }
        lastValue = value
        onValueChanged?(field, value)
    }

    // MARK: polling fallback

    private func startPolling() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + 0.5, repeating: 0.5, leeway: .milliseconds(100))
        timer.setEventHandler { [weak self] in self?.ax.async { self?.poll() } }
        timer.resume()
        pollTimer = timer
    }

    private func poll() {
        guard running, let app = activeApp, app.pid != ownPID else { return }
        let appElement = AXUIElementCreateApplication(app.pid)
        let focused = AX.element(appElement, kAXFocusedUIElementAttribute as String)
        switch (current, focused) {
        case (nil, nil):
            return
        case (nil, .some):
            refreshFocus(pid: app.pid)
        case (.some, nil):
            setCurrent(nil, value: "")
        case (.some(let field), .some(let focused)):
            if CFEqual(field.element, focused) {
                readValue(of: field)
            } else {
                refreshFocus(pid: app.pid)
            }
        }
    }

    // MARK: queries for the engine (AX thread)

    var focusedField: Field? { current }

    /// pid of the app that was activated last (AX thread).
    var activePID: pid_t? { activeApp?.pid }

    /// Tells the watcher what the field holds now (after the engine's own
    /// rewrite) so the next notification is not reported as a change.
    func noteValue(_ value: String, for field: Field) {
        guard current == field else { return }
        lastValue = value
    }
}
