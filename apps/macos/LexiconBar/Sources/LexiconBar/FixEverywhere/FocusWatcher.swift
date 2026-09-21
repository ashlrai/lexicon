import AppKit
import ApplicationServices
import LexiconBarKit

/// Follows the frontmost app and its focused text field through the
/// Accessibility API. One `AXObserver` per app pid receives
/// `kAXFocusedUIElementChanged` (on the application element) and
/// `kAXValueChanged` (on the application element and again on the focused
/// element, since apps differ in where they post it). A 500 ms poll on the
/// AX thread covers apps that post neither reliably (some Electron builds).
///
/// Callbacks run on the AX thread. `frontmostApp` is main-thread state for the menu.
///
/// Every path in here that would pull a field's text goes through `FieldGate`
/// first, so an excluded app's field and a secret-looking field are never read
/// at all: not on the focus change, not on a value-changed notification, not on
/// the poll. That is the only place the refusal can live and still be true,
/// because this class is what does the reading.
final class FocusWatcher: @unchecked Sendable {
    struct Field: Equatable {
        let element: AXUIElement
        let pid: pid_t
        let bundleID: String?
        let appName: String
        /// `AX.key` of the element; used for rate limits and undo.
        let key: String
        /// This field's own labels and those of its window, read once when
        /// focus lands. Captured here because `FieldGate` needs them on every
        /// poll to decide whether the value may be read, and because they are
        /// metadata, which is exactly what may be looked at before that
        /// decision is made.
        let hints: SecretFieldHeuristic.FieldHints
        /// The one call that brings this field's text across the process
        /// boundary, held as a value so the tests can stand in for it and
        /// count the calls that a refusal is supposed to prevent. `AX.value`
        /// everywhere in the app; there is no other way to read a field here.
        var value: (AXUIElement) -> String? = { AX.value($0) }

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
    /// pids already given the `AXEnhancedUserInterface` nudge.
    private var escalated: Set<pid_t> = []
    private var activeApp: FrontmostApp?
    private var current: Field?
    private var lastValue: String = ""
    /// The list the gate matches on. Starts as the defaults rather than empty:
    /// the watcher runs before any settings are pushed into it, and "no
    /// exclusions yet" must never be the state something gets read in.
    /// Readable from the test target (`@testable`) so a test can assert the
    /// list the user just edited actually arrived here.
    private(set) var exclusions = AppExclusions()
    /// The key of the field we last refused, so the log says so once rather
    /// than twice a second, and so the poll does not re-read a refused field's
    /// labels twice a second either.
    private var refusedKey = ""
    /// Which version of the exclusion list that refusal was made against.
    /// Bumped whenever the list actually changes, which is what makes the
    /// short circuit above safe: a refused field is re-examined as soon as the
    /// user edits the list, and not before.
    private var exclusionsVersion = 0
    private var refusedVersion = -1
    /// Whether "Fix everywhere" is on at all. False means this class reads
    /// nothing: the master switch is the other mitigation SECURITY.md offers,
    /// and it would not be one if the watcher kept pulling every focused
    /// field's text into memory with the feature off. Starts false because the
    /// watcher exists before the first config is pushed into it, and "nobody
    /// has said yet" must never be the state something gets read in.
    private(set) var reading = false
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
        guard app.pid != ownPID, reading else { setCurrent(nil, value: ""); return }
        ensureObserver(for: app.pid)
        refreshFocus(pid: app.pid)
    }

    /// Turns the whole read side on or off. AX thread.
    ///
    /// With it off nothing here touches a field: no focus resolution, no
    /// value-changed read, no poll, and whatever the last field held is
    /// dropped on the spot rather than at the next focus change.
    func setReading(_ on: Bool) {
        guard on != reading else { return }
        reading = on
        guard on else {
            setCurrent(nil, value: "")
            refusedKey = ""
            return
        }
        if let activeApp { activate(activeApp) }
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
        escalated.remove(pid)
        if current?.pid == pid { setCurrent(nil, value: "") }
    }

    private func handle(notification: String, element: AXUIElement) {
        guard running, reading, let pid = AX.pid(of: element), pid == activeApp?.pid else { return }
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
        guard reading else { setCurrent(nil, value: ""); return }
        let appElement = AXUIElementCreateApplication(pid)
        guard let focused = AX.element(appElement, kAXFocusedUIElementAttribute as String) else {
            escalateAccessibility(pid: pid, appElement: appElement)
            setCurrent(nil, value: "")
            return
        }
        if let current, CFEqual(current.element, focused) { return }
        // A refused field leaves `current` nil, so the poll comes back through
        // here twice a second for as long as it holds focus. Nothing about the
        // answer can have changed unless the user edited the exclusion list,
        // and re-deciding costs the eight round trips `AX.hints` takes, so the
        // refusal stands until it does.
        let key = AX.key(focused, pid: pid)
        if key == refusedKey, refusedVersion == exclusionsVersion { return }

        guard AX.couldBeEditableText(focused) else {
            setCurrent(nil, value: "")
            return
        }
        // Labels, not contents: `AX.hints` asks the tree what it says *about*
        // the field, and that is everything the gate decides on.
        let field = Field(element: focused, pid: pid, bundleID: activeApp?.bundleID, appName: activeApp?.name ?? "",
                          key: key, hints: AX.hints(focused))

        // The gate, before the first read. `FieldGate.read` does not call
        // `readValue` at all for a field it refuses, so a vault's notes field
        // never has its text in this process, not even for the instant it
        // would take to decide we are not interested.
        let read = FieldGate.read(field, exclusions: exclusions)
        if let refusal = read.refusal {
            refuse(field, refusal)
            return
        }
        // nil is not a refusal. The element answered no string, so it is not
        // the editable text field its metadata suggested; `couldBeEditableText`
        // leaves that last check to the read itself.
        guard let value = read.value else {
            setCurrent(nil, value: "")
            return
        }
        refusedKey = ""
        observe(element: focused, pid: pid)
        setCurrent(field, value: value)
    }

    /// Forget a refused field: no value was read, and anything cached for the
    /// field that held focus before it goes now too.
    private func refuse(_ field: Field, _ why: String) {
        if refusedKey != field.key || refusedVersion != exclusionsVersion {
            NSLog("LexiconBar fix: not reading this field in %@: %@", field.appName, why)
        }
        refusedKey = field.key
        refusedVersion = exclusionsVersion
        setCurrent(nil, value: "")
    }

    /// Re-runs the gate against the field being watched and drops it when the
    /// answer has changed. Pure string work over labels already in hand, with
    /// no round trips at all, which is what lets it run the moment the list
    /// changes rather than at the next focus change.
    @discardableResult
    private func dropCurrentIfRefused() -> Bool {
        guard let field = current,
              let why = FieldGate.refuse(exclusions: exclusions, bundleID: field.bundleID, hints: field.hints) else { return false }
        refuse(field, why)
        return true
    }

    /// Pushes the exclusion list the gate matches on. AX thread.
    ///
    /// The list arrives here and not only at `FixEngine` because this class is
    /// what does the reading: excluding an app has to stop the reads, not just
    /// the corrections. `AppExclusions` is a value type, so the watcher gets
    /// its own copy and the menu can keep editing the settings' one.
    func setExclusions(_ exclusions: AppExclusions) {
        if exclusions != self.exclusions {
            self.exclusions = exclusions
            // A field we already refused has to be re-examined against the new
            // list, so the user un-excluding the app they are typing in takes
            // effect on the next poll rather than at the next focus change.
            exclusionsVersion += 1
        }
        // The user can exclude the app that has focus right now, from the menu
        // or from Preferences, while its text is in `lastValue`. Drop it at
        // once rather than at the next focus change. Run unconditionally, even
        // for a list that compares equal to the one already held: the check is
        // pure string work over labels already in hand, and making it depend
        // on the comparison above is what let a stale push leave a refused
        // field being read.
        dropCurrentIfRefused()
    }

    /// Some apps answer "no focused element" until an assistive client asks
    /// them to build an Accessibility tree, and the two opt-in switches are
    /// not the same one. Electron and most Chromium embedders take
    /// `AXManualAccessibility`, which is set for every app in
    /// `ensureObserver`. The Codex/ChatGPT desktop app rejects that one
    /// (`kAXErrorAttributeUnsupported`) and stays dark: its whole window is
    /// six nested empty `AXGroup`s and `AXFocusedUIElement` answers
    /// `kAXErrorNoValue`. Writing `AXEnhancedUserInterface` — AppKit's own
    /// switch, the one VoiceOver sets — wakes it, and the composer turns out
    /// to be an ordinary writable `AXTextArea`.
    ///
    /// What actually wakes it is the *request*, not the attribute: the write
    /// below reports `kAXErrorNotImplemented` on Codex and the tree appears
    /// anyway, while the 500 ms focus poll had been reading the same app for
    /// minutes without ever waking it. So this is not "set a flag" so much as
    /// "knock the way an assistive client knocks", and the error code is
    /// logged rather than acted on.
    ///
    /// It is still not done for every app on sight: where the attribute *is*
    /// honoured, AppKit starts animating window frame changes while enhanced
    /// mode is on, which is why window managers complain about it. Only an
    /// app that has already told us it has no focused element gets the knock,
    /// at most once per pid; an app that answers normally never sees it. The
    /// 500 ms poll retries the focus read afterwards.
    private func escalateAccessibility(pid: pid_t, appElement: AXUIElement) {
        guard !escalated.contains(pid) else { return }
        escalated.insert(pid)
        let err = AX.set(appElement, "AXEnhancedUserInterface", bool: true)
        NSLog("LexiconBar: %@ reported no focused element; enabling AXEnhancedUserInterface (%d)",
              activeApp?.name ?? "pid \(pid)", err.rawValue)
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

    /// Internal rather than private so the test target can stand a focused
    /// field up: a headless test has no Accessibility grant and no focused
    /// element to be handed one from. Nothing outside this file calls it.
    func setCurrent(_ field: Field?, value: String) {
        if field == nil, current == nil { return }
        current = field
        lastValue = value
        onFieldChanged?(field, value)
    }

    /// The read behind both the value-changed notification and the poll. Both
    /// are reads like any other, so both are the gate's decision and not only
    /// the focus change: focus has not moved, but the exclusion list may have.
    ///
    /// Internal rather than private for the same reason as `setCurrent`: this
    /// is the call a test drives to prove that a field in an app excluded
    /// mid-focus stops being read.
    func readValue(of field: Field) {
        guard reading else { setCurrent(nil, value: ""); return }
        let read = FieldGate.read(field, exclusions: exclusions)
        if let refusal = read.refusal {
            refuse(field, refusal)
            return
        }
        // The element stopped answering with a string: leave the cache alone
        // and let the poll re-resolve focus.
        guard let value = read.value else { return }
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
        guard running, reading, let app = activeApp, app.pid != ownPID else { return }
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

/// The gate's view of a focused field: identity and labels for free, the value
/// only through the one call it guards.
extension FocusWatcher.Field: InspectableField {
    /// The single Accessibility call that brings the user's own text into this
    /// process. Nothing else in `Field` touches `AXValue`.
    func readValue() -> String? { value(element) }
}
