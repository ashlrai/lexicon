import Combine
import XCTest
@testable import LexiconBar
@testable import LexiconBarKit

/// The wiring between the exclusion list the user edits and the code that
/// reads their text: `Settings` -> `FixEngine.update` -> `FocusWatcher`.
///
/// `FieldGateTests` covers the decision; these cover the delivery, which is
/// where it was broken. `@Published` emits from `willSet`, so the old sinks,
/// which threw the emitted value away and read `settings.exclusions` back off
/// the object, saw the list from *before* the change. The watcher compared
/// that stale list to the one it already held, found them equal, returned
/// early, and went on reading the field in the app the user had just excluded.
/// Every assertion about the pure gate still passed.
///
/// So these tests drive the real objects and the real publisher, and the field
/// they focus counts every attempt to fetch its value. "Excluded" has to mean
/// that count stops moving.
final class FixEverywhereWiringTests: XCTestCase {
    /// Stands in for the one Accessibility call that brings a field's text
    /// into this process, and counts the calls. Locked because the watcher and
    /// the engine do their work on the AX thread.
    private final class ValueReads: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        private let text: String

        init(text: String = "the quick brown fox") { self.text = text }

        func read() -> String? {
            lock.lock()
            defer { lock.unlock() }
            count += 1
            return text
        }

        var reads: Int {
            lock.lock()
            defer { lock.unlock() }
            return count
        }
    }

    /// What the engine reported, collected off whichever thread reports it.
    private final class EventLog: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [FixEngine.Event] = []

        func append(_ event: FixEngine.Event) {
            lock.lock()
            defer { lock.unlock() }
            items.append(event)
        }

        var all: [FixEngine.Event] {
            lock.lock()
            defer { lock.unlock() }
            return items
        }

        /// The reasons reported as skips, which is how every refusal surfaces.
        var skips: [String] {
            all.compactMap { if case .skipped(let why) = $0 { return why } else { return nil } }
        }

        var undone: Bool { all.contains { if case .undone = $0 { return true } else { return false } } }
    }

    /// The three objects the app wires together, wired the way the app wires
    /// them.
    @MainActor
    private final class Harness {
        let settings: Settings
        let watcher: FocusWatcher
        let engine: FixEngine
        let events = EventLog()
        let ax = AXThread()
        private let suite: String
        private var bag: Set<AnyCancellable> = []

        init() {
            suite = "ai.ashlr.lexiconbar.tests.\(UUID().uuidString)"
            settings = Settings(defaults: UserDefaults(suiteName: suite)!)
            watcher = FocusWatcher(ax: ax)
            engine = FixEngine(ax: ax, watcher: watcher, client: NormalizeClient())
        }

        /// The subscription `AppDelegate.startFixEverywhere` makes, and the
        /// only one: the config is built from the values the publisher carries
        /// and nothing is read back off `settings`.
        func subscribe() {
            let engine = self.engine
            let events = self.events
            engine.onEvent = { events.append($0) }
            settings.fixSettingsChanges
                .sink { fix in engine.update(FixEngine.Config(fix)) }
                .store(in: &bag)
        }

        /// Runs `body` on the AX thread, where the watcher's state lives,
        /// after everything already queued there has finished.
        func onAX(_ body: @escaping () -> Void) {
            let done = DispatchSemaphore(value: 0)
            ax.async {
                body()
                done.signal()
            }
            XCTAssertEqual(done.wait(timeout: .now() + 5), .success, "the AX thread did not come back")
        }

        func flush() { onAX {} }

        /// A focused field in `bundleID` whose value comes from `reads`, put in
        /// place as if focus had just landed on it. A headless test has no
        /// Accessibility grant and no focused element, so this is the way in.
        @discardableResult
        func focus(_ bundleID: String, reads: ValueReads, title: String = "Item") -> FocusWatcher.Field {
            let field = FocusWatcher.Field(element: AXUIElementCreateApplication(getpid()),
                                           pid: getpid(),
                                           bundleID: bundleID,
                                           appName: bundleID,
                                           key: "\(bundleID):1",
                                           hints: SecretFieldHeuristic.FieldHints(title: title),
                                           value: { _ in reads.read() })
            let watcher = self.watcher
            onAX { watcher.setCurrent(field, value: "the quick brown fox") }
            return field
        }

        /// One read of the focused field, the same one the 500 ms poll makes.
        func poll(_ field: FocusWatcher.Field, times: Int = 1) {
            let watcher = self.watcher
            onAX { for _ in 0..<times { watcher.readValue(of: field) } }
        }

        /// What the menu's "Fix everywhere in <app>" switch does.
        func toggleFromMenu(_ bundleID: String) {
            var exclusions = settings.exclusions
            exclusions.toggle(bundleID)
            settings.exclusions = exclusions
            flush()
        }

        func tearDown() {
            bag.removeAll()
            UserDefaults.standard.removePersistentDomain(forName: suite)
        }
    }

    /// Lets the queued `DispatchQueue.main.async` reports run. The engine
    /// reports on main, and a synchronous test method is holding it.
    private func pumpMain() {
        let pumped = expectation(description: "main queue drained")
        DispatchQueue.main.async { pumped.fulfill() }
        wait(for: [pumped], timeout: 5)
    }

    // MARK: the list reaching the watcher

    /// Subscribing is the first push: the watcher must never be left reading
    /// with no list until the user happens to change something.
    @MainActor
    func testSubscribingPushesTheCurrentSettingsIntoTheWatcher() {
        let h = Harness()
        defer { h.tearDown() }
        XCTAssertFalse(h.watcher.reading, "nothing may be read before a config arrives")

        h.subscribe()
        h.flush()

        XCTAssertTrue(h.watcher.reading)
        XCTAssertEqual(h.watcher.exclusions, h.settings.exclusions)
        XCTAssertTrue(h.watcher.exclusions.isExcluded("com.apple.Terminal"))
    }

    /// The regression this file exists for, at the delivery end: the list the
    /// user just edited is the list the watcher matches on.
    @MainActor
    func testExcludingAnAppReachesTheWatcherWithTheNewList() {
        let h = Harness()
        defer { h.tearDown() }
        h.subscribe()
        h.flush()
        XCTAssertFalse(h.watcher.exclusions.isExcluded("com.obscurevault.desktop"))

        h.toggleFromMenu("com.obscurevault.desktop")

        XCTAssertTrue(h.watcher.exclusions.isExcluded("com.obscurevault.desktop"),
                      "the watcher is still matching on the list from before the change")
    }

    /// The master switch is the other mitigation on offer, so it has to reach
    /// the watcher too, and it has to mean "read nothing" rather than "correct
    /// nothing".
    @MainActor
    func testTurningFixEverywhereOffStopsTheWatcherReadingAtAll() {
        let h = Harness()
        defer { h.tearDown() }
        h.subscribe()
        let reads = ValueReads()
        let field = h.focus("com.apple.TextEdit", reads: reads)
        h.poll(field)
        XCTAssertEqual(reads.reads, 1)

        h.settings.fixEverywhere = false
        h.flush()

        XCTAssertFalse(h.watcher.reading)
        XCTAssertNil(h.watcher.focusedField, "the field it was holding goes with the switch")
        h.poll(field)
        XCTAssertEqual(reads.reads, 1, "the read count must not move with the feature off")
    }

    // MARK: the field stops being read

    /// The claim in SECURITY.md, end to end: exclude the app that has focus
    /// right now and its field stops being read at that moment.
    @MainActor
    func testAFieldInAnAppExcludedMidFocusStopsBeingRead() {
        let h = Harness()
        defer { h.tearDown() }
        h.subscribe()
        let reads = ValueReads()
        let field = h.focus("com.obscurevault.desktop", reads: reads)

        // The poll, while the app is still admitted.
        h.poll(field)
        XCTAssertEqual(reads.reads, 1)
        XCTAssertNotNil(h.watcher.focusedField)

        h.toggleFromMenu("com.obscurevault.desktop")

        XCTAssertNil(h.watcher.focusedField, "the text it was holding is dropped at that moment")
        // Every later poll, and the value-changed notification with it.
        h.poll(field, times: 2)
        XCTAssertEqual(reads.reads, 1, "the field was read after its app was excluded")
    }

    /// Un-excluding it puts it back: the refusal is re-decided against the new
    /// list rather than remembered.
    @MainActor
    func testIncludingTheAppAgainLetsItBeReadOnceMore() {
        let h = Harness()
        defer { h.tearDown() }
        h.subscribe()
        let reads = ValueReads()
        let field = h.focus("com.obscurevault.desktop", reads: reads)
        h.toggleFromMenu("com.obscurevault.desktop")
        h.poll(field)
        XCTAssertEqual(reads.reads, 0)

        h.toggleFromMenu("com.obscurevault.desktop")  // the same switch, back on
        let watcher = h.watcher
        h.onAX {
            watcher.setCurrent(field, value: "the quick brown fox")
            watcher.readValue(of: field)
        }

        XCTAssertFalse(h.watcher.exclusions.isExcluded("com.obscurevault.desktop"))
        XCTAssertEqual(reads.reads, 1)
    }

    // MARK: undo

    /// Undo reads the field and then writes into it, so it asks the gate
    /// first. It used to go straight to the Accessibility API, which made
    /// the undo hotkey the one way to both read and write a field in an app
    /// the user believed they had excluded.
    @MainActor
    func testUndoAsksTheGateBeforeItReads() {
        let h = Harness()
        defer { h.tearDown() }
        h.subscribe()
        let reads = ValueReads()
        h.focus("com.obscurevault.desktop", reads: reads)

        h.engine.undoLast()
        h.flush()
        pumpMain()

        XCTAssertEqual(reads.reads, 1, "an admitted field is read through the gate")
        XCTAssertEqual(h.events.skips, ["Nothing to undo in com.obscurevault.desktop."])
        XCTAssertFalse(h.events.undone)
    }

    /// The gate's other half on the same path: labels that look like a secret
    /// stop undo before the read, exactly as they stop a correction.
    @MainActor
    func testUndoRefusesAFieldWhoseLabelsLookLikeASecret() {
        let h = Harness()
        defer { h.tearDown() }
        h.subscribe()
        let reads = ValueReads()
        h.focus("com.apple.TextEdit", reads: reads, title: "Recovery phrase")

        h.engine.undoLast()
        h.flush()
        pumpMain()

        XCTAssertEqual(reads.reads, 0)
        XCTAssertFalse(h.events.undone)
        XCTAssertTrue(h.events.skips.contains { $0.contains("look like a secret") },
                      "\(h.events.skips)")
    }

    @MainActor
    func testUndoInAnAppExcludedMidFocusNeitherReadsNorWrites() {
        let h = Harness()
        defer { h.tearDown() }
        h.subscribe()
        let reads = ValueReads()
        h.focus("com.obscurevault.desktop", reads: reads)
        h.toggleFromMenu("com.obscurevault.desktop")

        h.engine.undoLast()
        h.flush()
        pumpMain()

        // Two things hold it back, and either alone is enough: the watcher
        // dropped the field when the list arrived, and the engine asks the
        // gate before it reads. The property is what is asserted.
        XCTAssertEqual(reads.reads, 0, "undo read a field in an excluded app")
        XCTAssertFalse(h.events.undone, "undo wrote into a field in an excluded app")
        XCTAssertFalse(h.events.skips.isEmpty)
    }

    @MainActor
    func testUndoDoesNothingWithFixEverywhereOff() {
        let h = Harness()
        defer { h.tearDown() }
        h.subscribe()
        let reads = ValueReads()
        h.focus("com.apple.TextEdit", reads: reads)
        h.settings.fixEverywhere = false
        h.flush()

        h.engine.undoLast()
        h.flush()
        pumpMain()

        XCTAssertEqual(reads.reads, 0)
        XCTAssertFalse(h.events.undone)
        XCTAssertEqual(h.events.skips, ["Nothing to undo: no text field focused."])
    }
}
