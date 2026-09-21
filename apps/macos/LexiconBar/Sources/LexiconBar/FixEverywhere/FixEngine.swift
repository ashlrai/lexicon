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
        /// Silence that ends a streamed dictation run; see `BurstDetector`.
        var runQuietMs = 1500
        var maxRunMs = 12_000
        /// One API call per element per this many seconds.
        var rateLimit: TimeInterval = 0.3

        init() {}

        /// The four user-facing knobs, as `Settings` hands them over. Taking
        /// the whole snapshot is the point: nothing here reads a published
        /// property back off `Settings`, where it would still hold the value
        /// from before the change.
        init(_ fix: Settings.FixSettings) {
            self.init()
            enabled = fix.enabled
            settleMs = Int(fix.settleMs)
            minWords = fix.minWords
            exclusions = fix.exclusions
        }
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
            // The watcher gates its own reads, so it needs both the master
            // switch and the list, and it needs them before anything below
            // looks at `field`: excluding the app that has focus right now has
            // to drop the cached text there and here in the same breath.
            //
            // The list goes first, which is the order Windows was given, and
            // for the same reason: `setReading(true)` is not a flag, it
            // re-resolves focus and reads whatever field it finds, and it would
            // decide that read against the list the watcher still held. The
            // narrow case is the first push of all, at launch, where the
            // watcher is still on the default list and the user's saved
            // exclusions are in the config arriving now. Turning the switch on
            // one line earlier reads a field in an app the user excluded,
            // through a gate that has not been told yet.
            watcher.setExclusions(config.exclusions)
            watcher.setReading(config.enabled)
            detector?.config = detectorConfig
            if wasEnabled != config.enabled { settleGeneration += 1 }
            guard config.enabled else {
                // Off is off. The detector's copy of the field's text goes,
                // and so does the undo ledger's copy of the last correction:
                // turning "Fix everywhere" off is the mitigation SECURITY.md
                // offers, and it would not be one if ⌃⌥Z could still read the
                // field and write into it afterwards.
                forgetField()
                return
            }
            guard let field else { return }
            // The config that just arrived may be the one that excludes this
            // very app, and this class is holding that app's text. Re-decide
            // on every push, not only on the off-to-on edge.
            if let why = refusal(for: field) {
                if detector != nil || undo.last != nil {
                    log("not watching this field in \(field.appName): \(why)")
                }
                forgetField()
                return
            }
            // Admitted, and nothing cached for it: that is either the on edge
            // or the user putting this app back. Refusal first, read second.
            if detector == nil {
                let read = FieldGate.read(field, exclusions: config.exclusions)
                guard read.refusal == nil else { return }
                detector = BurstDetector(initialText: read.value ?? "", config: detectorConfig)
            }
        }
    }

    /// Drops everything this class holds about the focused field: the
    /// detector, which caches the field's text to tell dictation from typing,
    /// and the undo ledger, which holds the last correction and the text it
    /// replaced. Called when the field stops being one we may read, so that
    /// "excluded" means the text goes now rather than at the next focus
    /// change.
    private func forgetField() {
        detector = nil
        settleGeneration += 1
        undo.clear()
        publishUndoAvailability(currentText: "", force: true)
    }

    /// ⌃⌥Z: put the previous text back if the same field still holds the corrected text.
    func undoLast() {
        ax.async { [self] in performUndo() }
    }

    /// Seeds the ledger with the entry a correction leaves behind.
    ///
    /// Internal rather than private so the test target can stand an undo up,
    /// for the same reason `FocusWatcher.setCurrent` is: a headless test has no
    /// Accessibility grant and no local API, so it cannot make a correction
    /// happen and cannot reach the line in `apply` that records one. What needs
    /// a test here is what becomes of this entry when the undo's own write does
    /// not land, which is where it used to be thrown away. Nothing outside the
    /// tests calls it.
    func recordUndo(_ entry: UndoLedger.Entry) {
        ax.async { [self] in undo.record(entry) }
    }

    // MARK: AX thread

    private var detectorConfig: BurstDetector.Config {
        BurstDetector.Config(settleMs: config.settleMs, minWords: config.minWords,
                             maxFieldLength: config.maxFieldLength,
                             runQuietMs: config.runQuietMs, maxRunMs: config.maxRunMs)
    }

    private func fieldChanged(_ field: FocusWatcher.Field?, value: String) {
        self.field = field
        settleGeneration += 1
        detector = field.flatMap { makeDetector(for: $0, value: value) }
        publishUndoAvailability(currentText: value)
    }

    /// A detector, unless this field is one we refuse outright.
    ///
    /// This is **defence in depth, not the guard itself**. The guard is in
    /// `FocusWatcher`, which asks `FieldGate` before it reads anything, so a
    /// refused field's text never reaches this class to begin with: a value
    /// handed to this method has already been admitted. What the check still
    /// buys is the case where the two disagree. The watcher's copy of the list
    /// and this class's are pushed together but held separately, and the
    /// watcher decides on the labels it captured when focus landed, so
    /// refusing here too means the stricter of the two always wins.
    ///
    /// The same check runs again in `handle`, immediately before anything is
    /// sent to the local API, and again in `apply`, before anything is written
    /// back.
    private func makeDetector(for field: FocusWatcher.Field, value: String) -> BurstDetector? {
        if let why = refusal(for: field) {
            log("not watching this field in \(field.appName): \(why)")
            return nil
        }
        return BurstDetector(initialText: value, config: detectorConfig)
    }

    /// Why this field is one we will not act on, or nil. The same call the
    /// watcher gates its reads with, against this class's copy of the config.
    private func refusal(for field: FocusWatcher.Field) -> String? {
        FieldGate.refuse(exclusions: config.exclusions, bundleID: field.bundleID, hints: field.hints)
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
        // Where the caret is now tells the detector which of several textually
        // identical windows actually arrived. Without it a paste in front of
        // text that starts the same way is located several units late.
        let caret = AX.range(field.element, kAXSelectedTextRangeAttribute as String)
        switch detector.settle(at: now, caretEnd: caret.map { $0.location + $0.length }) {
        case .waiting:
            // A change landed after the timer was armed; the newer timer will fire.
            return
        case .coalescing:
            // Dictation is still streaming in. Nothing was decided and the
            // detector kept the run pending, so ask again shortly — no value
            // change is coming to re-arm the timer if the user has stopped
            // speaking mid-run.
            settleGeneration += 1
            let generation = settleGeneration
            ax.after(0.25) { [weak self] in
                guard let self, generation == self.settleGeneration else { return }
                self.settle()
            }
            return
        case .skipped(let why):
            log("skip in \(field.appName): \(why)")
        case .burst(let burst):
            handle(burst, in: field)
        }
    }

    private func handle(_ burst: Burst, in field: FocusWatcher.Field) {
        // The second of the three checks, and the one that matters most: this
        // is the call that would put the text on the wire. Nothing about the
        // burst is logged or sent when it refuses.
        if let why = refusal(for: field) {
            log("skip in \(field.appName): \(why)")
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
        // The API round trip is the longest gap in the flow, and the user can
        // exclude this app from the menu while it is open. Do not read the
        // field, and do not write into it, if they did.
        if let why = refusal(for: field) {
            log("skip in \(field.appName): \(why)")
            return
        }
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
    ///
    /// The two range strategies are gated on the app agreeing about *what* the
    /// range covers: after selecting `plan.range` the selection is read back
    /// and must hold exactly the text the plan replaces. A range that lands
    /// even one unit off would otherwise splice the correction into the middle
    /// of a word and drop the rest of the burst. When the app will not say, or
    /// says something else, the whole-value write takes over — it is computed
    /// from `before` alone and so cannot be misaligned.
    private func write(_ plan: RewritePlan.Plan, to element: AXUIElement, before: String, pid: pid_t) -> (strategy: String?, detail: String) {
        let selectAttr = kAXSelectedTextRangeAttribute as String
        let selectedTextAttr = kAXSelectedTextAttribute as String
        let valueAttr = kAXValueAttribute as String
        var notes: [String] = []

        // The plan was made when the API answered; the field has been live
        // since. Re-read it before touching anything.
        guard (AX.value(element) ?? "") == before else { return (nil, "field changed before the write") }

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

        // Does the app mean the same span we do?
        if selected {
            let held = AX.string(element, selectedTextAttr)
            if held != plan.previousText {
                notes.append(held == nil ? "selection unreadable" : "selection holds other text")
                selected = false
            }
        }
        // The selection round-trip took time; make sure the field is still the
        // one the plan was computed from before the destructive write.
        if selected, (AX.value(element) ?? "") != before {
            return (nil, "field changed while selecting (\(notes.joined(separator: ", ")))")
        }

        if selected {
            let textErr = AX.set(element, selectedTextAttr, string: plan.newText)
            if textErr == .success, verify(element, equals: plan.splicedFullText, within: 0.2) {
                AX.set(element, selectAttr, range: plan.caret)
                return ("selection", notes.joined(separator: ", "))
            }
            notes.append("selectedText \(textErr.rawValue)")
            let after = AX.value(element) ?? ""
            guard after == before else {
                // Something landed but not what was planned: stop here rather
                // than write again on top of a field we no longer understand.
                return (nil, "the selection write changed the field to something else; left alone (\(notes.joined(separator: ", ")))")
            }

            // Still selected, still holding the right text, untouched: type over it.
            if watcher.activePID == pid, !plan.newText.contains(where: { $0.isNewline }),
               AX.range(element, selectAttr) == plan.range,
               AX.string(element, selectedTextAttr) == plan.previousText {
                FixEngine.typeUnicode(plan.newText)
                if verify(element, equals: plan.splicedFullText, within: 0.6) {
                    return ("keystrokes", notes.joined(separator: ", "))
                }
                notes.append("keystrokes not reflected")
                guard (AX.value(element) ?? "") == before else {
                    return (nil, "typing changed the field to something else; left alone (\(notes.joined(separator: ", ")))")
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
        guard let field else { report(.skipped("Nothing to undo: no text field focused.")); return }
        // Undo reads the field and then writes into it, so it is a read like
        // any other and asks the gate first. It used to go straight to
        // `AX.value`, which meant ⌃⌥Z on a field in an app the user had just
        // excluded both read that field and typed into it, while every other
        // path in the engine refused it.
        guard config.enabled else { report(.skipped("Fix everywhere is off.")); return }
        let read = FieldGate.read(field, exclusions: config.exclusions)
        if let why = read.refusal {
            log("skip undo in \(field.appName): \(why)")
            // The entry holds that field's text; it goes with the refusal.
            undo.clear()
            report(.skipped("Not undoing in \(field.appName): \(why)"))
            publishUndoAvailability(currentText: "", force: true)
            return
        }
        guard let detector else { report(.skipped("Nothing to undo: no text field focused.")); return }
        let current = read.value ?? ""
        // Read, not consumed. This used to be `undo.take`, which clears the
        // entry whatever happens next, so an undo whose write did nothing threw
        // away the only record of the correction: the field still held text the
        // user never typed and there was no longer anything that could put
        // theirs back. The write below fails for reasons that have nothing to
        // do with the entry being wrong, starting with the field changing
        // between the read and the write. Windows fixed the same bug in
        // `FixEngine.cs`; this is the mirror of it.
        guard undo.canUndo(fieldKey: field.key, currentText: current),
              let entry = undo.last,
              let before = entry.fieldTextBefore else {
            report(.skipped("Nothing to undo in \(field.appName)."))
            publishUndoAvailability(currentText: current, force: true)
            return
        }
        let plan = RewritePlan.Plan(range: NSRange(location: entry.range.location, length: entry.correctedText.utf16.count),
                                    previousText: entry.correctedText, newText: entry.previousText, splicedFullText: before)
        let outcome = write(plan, to: field.element, before: current, pid: field.pid)
        if outcome.strategy != nil {
            // Consumed only now, once the field actually holds the user's own
            // text again.
            undo.clear()
            detector.markStable(before)
            watcher.noteValue(before, for: field)
            report(.undone(appName: field.appName))
        } else {
            // The entry is untouched, so the offer stands and ⌃⌥Z can be
            // pressed again.
            report(.failed("Undo failed in \(field.appName): \(outcome.detail)"))
        }
        // Through the gate, like every other read in this class. The raw
        // `AX.value` this used to call was the one read here that nothing
        // decided on first, and it answered for a field the rest of the method
        // had been careful to ask about.
        publishUndoAvailability(currentText: FieldGate.read(field, exclusions: config.exclusions).value ?? "",
                                force: true)
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
