import AppKit
import ApplicationServices
import LexiconBarKit

/// "Fix everywhere": watches the focused field, turns dictation-sized
/// insertions into bursts, normalizes them through the local API and writes
/// the corrected span back through Accessibility.
///
/// All state lives on the AX thread. `Config` is pushed from the main thread
/// with `update(_:)`; results come back on main through `onFixed` / `onEvent`.
final class FixEngine: @unchecked Sendable {
    struct Config: Equatable {
        var enabled = true
        var settleMs = 700
        var minWords = 3
        var exclusions = AppExclusions()
        var maxFieldLength = 20_000
        /// One API call per element per this many seconds.
        var rateLimit: TimeInterval = 0.3
    }

    struct Fix: Equatable {
        let appName: String
        let bundleID: String?
        let replacements: [Replacement]
        let summary: String
        /// "selection" (AXSelectedText write) or "value" (whole-value fallback).
        let strategy: String
        let elapsedMs: Int
        /// Where the caret ended up, in Quartz global coordinates, for the
        /// correction bubble. nil when the app exposes no usable geometry.
        let caret: CGRect?
    }

    enum Event: Equatable {
        case fixed(Fix)
        case undone(appName: String)
        case skipped(String)
        case failed(String)
        case undoAvailable(Bool)
    }

    /// Main thread.
    var onEvent: ((Event) -> Void)?

    private let ax: AXThread
    private let watcher: FocusWatcher
    private let client: NormalizeClient
    private var config = Config()
    private var detector: BurstDetector?
    private var field: FocusWatcher.Field?
    private var settleGeneration = 0
    private var lastRequestAt: [String: TimeInterval] = [:]
    private var inFlight = false
    private var undo = UndoLedger()
    private var undoWasAvailable = false

    init(ax: AXThread, watcher: FocusWatcher, client: NormalizeClient) {
        self.ax = ax
        self.watcher = watcher
        self.client = client
        watcher.onFieldChanged = { [weak self] field, value in self?.fieldChanged(field, value: value) }
        watcher.onValueChanged = { [weak self] field, value in self?.valueChanged(field, value: value) }
    }

    // MARK: main-thread API

    func update(_ config: Config) {
        ax.async { [self] in
            let wasEnabled = self.config.enabled
            self.config = config
            detector?.config = detectorConfig
            if wasEnabled, !config.enabled { detector = nil; settleGeneration += 1 }
            if !wasEnabled, config.enabled, let field {
                detector = BurstDetector(initialText: AX.value(field.element) ?? "", config: detectorConfig)
            }
        }
    }

    /// ⌃⌥Z: put the previous text back if the same field still holds the corrected text.
    func undoLast() {
        ax.async { [self] in performUndo() }
    }

    // MARK: AX thread

    private var detectorConfig: BurstDetector.Config {
        BurstDetector.Config(settleMs: config.settleMs, minWords: config.minWords, maxFieldLength: config.maxFieldLength)
    }

    private func fieldChanged(_ field: FocusWatcher.Field?, value: String) {
        self.field = field
        settleGeneration += 1
        detector = field.map { _ in BurstDetector(initialText: value, config: detectorConfig) }
        publishUndoAvailability(currentText: value)
    }

    private func valueChanged(_ field: FocusWatcher.Field, value: String) {
        guard config.enabled, field == self.field, let detector else { return }
        detector.record(text: value, at: now)
        publishUndoAvailability(currentText: value)
        guard detector.hasPendingChanges else { return }
        settleGeneration += 1
        let generation = settleGeneration
        ax.after(Double(config.settleMs) / 1000 + 0.01) { [weak self] in
            guard let self, generation == self.settleGeneration else { return }
            self.settle()
        }
    }

    private func settle() {
        guard config.enabled, let detector, let field else { return }
        switch detector.settle(at: now) {
        case .waiting:
            // A change landed after the timer was armed; the newer timer will fire.
            return
        case .skipped(let why):
            log("skip in \(field.appName): \(why)")
        case .burst(let burst):
            handle(burst, in: field)
        }
    }

    private func handle(_ burst: Burst, in field: FocusWatcher.Field) {
        if config.exclusions.isExcluded(field.bundleID) {
            log("skip: \(field.bundleID ?? field.appName) is excluded")
            return
        }
        if let last = lastRequestAt[field.key], now - last < config.rateLimit {
            log("skip: rate limit")
            return
        }
        guard !inFlight else { log("skip: request in flight"); return }
        lastRequestAt[field.key] = now
        inFlight = true
        let started = now
        client.normalize(burst.text) { [weak self] result in
            guard let self else { return }
            self.ax.async {
                self.inFlight = false
                switch result {
                case .failure(let failure):
                    self.report(.failed(failure.description))
                case .success(let response):
                    self.apply(burst, response: response, in: field, started: started)
                }
            }
        }
    }

    private func apply(_ burst: Burst, response: NormalizeResponse, in field: FocusWatcher.Field, started: TimeInterval) {
        guard config.enabled, field == self.field, let detector else { return }
        let current = AX.value(field.element) ?? ""
        let plan: RewritePlan.Plan
        switch RewritePlan.make(burst: burst, response: response, currentFieldText: current, maxFieldLength: config.maxFieldLength) {
        case .failure(.unchanged):
            return
        case .failure(let refusal):
            log("refused: \(refusal)")
            return
        case .success(let made):
            plan = made
        }
        let outcome = write(plan, to: field.element, before: current, pid: field.pid)
        guard let strategy = outcome.strategy else {
            report(.failed("Could not write into \(field.appName): \(outcome.detail)"))
            return
        }
        detector.markStable(plan.splicedFullText)
        watcher.noteValue(plan.splicedFullText, for: field)
        undo.record(UndoLedger.Entry(fieldKey: field.key, range: plan.range, correctedText: plan.newText,
                                     previousText: plan.previousText, fieldTextAfter: plan.splicedFullText))
        publishUndoAvailability(currentText: plan.splicedFullText, force: true)
        // Read the caret here, on the AX thread, right after the write: the
        // main thread must never make AX calls into another app.
        let fix = Fix(appName: field.appName, bundleID: field.bundleID,
                      replacements: response.replacements.map(\.asReplacement), summary: response.summary,
                      strategy: strategy, elapsedMs: Int((now - started) * 1000),
                      caret: AX.caretRect(field.element))
        report(.fixed(fix))
    }

    /// Three strategies, each verified by re-reading the field:
    ///  1. select the burst range, write `AXSelectedText` (Cocoa text views;
    ///     keeps the app's undo stack);
    ///  2. select the burst range, then type the replacement as a unicode
    ///     keystroke event (Chromium/Electron accept the selection but ignore
    ///     `AXSelectedText`; the keystroke goes through the editor's normal
    ///     input path, so undo works there too);
    ///  3. write the whole spliced `AXValue` (last resort; loses undo).
    /// `before` is the field value the plan was made from; nothing is written
    /// when the field no longer holds it.
    private func write(_ plan: RewritePlan.Plan, to element: AXUIElement, before: String, pid: pid_t) -> (strategy: String?, detail: String) {
        let selectAttr = kAXSelectedTextRangeAttribute as String
        let selectedTextAttr = kAXSelectedTextAttribute as String
        let valueAttr = kAXValueAttribute as String
        var notes: [String] = []

        // Chromium applies AXSelectedTextRange asynchronously; poll briefly.
        let rangeErr = AX.set(element, selectAttr, range: plan.range)
        var selected = rangeErr == .success && AX.range(element, selectAttr) == plan.range
        if rangeErr == .success, !selected {
            for _ in 0..<12 where !selected {
                usleep(25_000)
                selected = AX.range(element, selectAttr) == plan.range
            }
        }
        notes.append("range \(rangeErr.rawValue)\(selected ? "" : " not confirmed")")

        if selected {
            let textErr = AX.set(element, selectedTextAttr, string: plan.newText)
            if textErr == .success, verify(element, equals: plan.splicedFullText, within: 0.2) {
                AX.set(element, selectAttr, range: plan.caret)
                return ("selection", notes.joined(separator: ", "))
            }
            notes.append("selectedText \(textErr.rawValue)")
            let after = AX.value(element) ?? ""
            guard after == before else { return (nil, "field changed after the selection write (\(notes.joined(separator: ", ")))") }

            // Still selected and untouched: type over the selection.
            if watcher.activePID == pid, !plan.newText.contains(where: { $0.isNewline }),
               AX.range(element, selectAttr) == plan.range {
                FixEngine.typeUnicode(plan.newText)
                if verify(element, equals: plan.splicedFullText, within: 0.6) {
                    return ("keystrokes", notes.joined(separator: ", "))
                }
                notes.append("keystrokes not reflected")
                guard (AX.value(element) ?? "") == before else {
                    return (nil, "field changed after typing (\(notes.joined(separator: ", ")))")
                }
            } else {
                notes.append("keystrokes skipped")
            }
        }

        guard (AX.value(element) ?? "") == before else { return (nil, "field changed (\(notes.joined(separator: ", ")))") }
        let valueErr = AX.set(element, valueAttr, string: plan.splicedFullText)
        guard valueErr == .success else { return (nil, "AXValue \(valueErr.rawValue) (\(notes.joined(separator: ", ")))") }
        if verify(element, equals: plan.splicedFullText, within: 0.3) {
            AX.set(element, selectAttr, range: plan.caret)
            return ("value", notes.joined(separator: ", "))
        }
        return (nil, "value write not reflected (\(notes.joined(separator: ", ")))")
    }

    /// Re-reads the field until it holds `expected` or `seconds` pass.
    private func verify(_ element: AXUIElement, equals expected: String, within seconds: TimeInterval) -> Bool {
        let deadline = now + seconds
        while true {
            if AX.value(element) == expected { return true }
            if now >= deadline { return false }
            usleep(25_000)
        }
    }

    /// Posts `text` as keyboard events carrying unicode strings (20 units per
    /// event, no virtual key, no modifiers). Lands in whatever has keyboard
    /// focus, so callers check the target app is frontmost first.
    static func typeUnicode(_ text: String) {
        let units = Array(text.utf16)
        var index = 0
        while index < units.count {
            let chunk = Array(units[index..<min(index + 20, units.count)])
            for keyDown in [true, false] {
                guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: keyDown) else { continue }
                event.flags = []
                event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                event.post(tap: .cghidEventTap)
            }
            index += chunk.count
        }
    }

    private func performUndo() {
        guard let field, let detector else { report(.skipped("Nothing to undo: no text field focused.")); return }
        let current = AX.value(field.element) ?? ""
        guard let entry = undo.take(fieldKey: field.key, currentText: current), let before = entry.fieldTextBefore else {
            report(.skipped("Nothing to undo in \(field.appName)."))
            publishUndoAvailability(currentText: current, force: true)
            return
        }
        let plan = RewritePlan.Plan(range: NSRange(location: entry.range.location, length: entry.correctedText.utf16.count),
                                    previousText: entry.correctedText, newText: entry.previousText, splicedFullText: before)
        let outcome = write(plan, to: field.element, before: current, pid: field.pid)
        if outcome.strategy != nil {
            detector.markStable(before)
            watcher.noteValue(before, for: field)
            report(.undone(appName: field.appName))
        } else {
            report(.failed("Undo failed in \(field.appName): \(outcome.detail)"))
        }
        publishUndoAvailability(currentText: AX.value(field.element) ?? "", force: true)
    }

    private func publishUndoAvailability(currentText: String, force: Bool = false) {
        let available = field.map { undo.canUndo(fieldKey: $0.key, currentText: currentText) } ?? false
        guard force || available != undoWasAvailable else { return }
        undoWasAvailable = available
        report(.undoAvailable(available))
    }

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    private func log(_ message: String) {
        NSLog("LexiconBar fix: %@", message)
    }

    private func report(_ event: Event) {
        if case .failed(let why) = event { log(why) }
        DispatchQueue.main.async { self.onEvent?(event) }
    }
}
