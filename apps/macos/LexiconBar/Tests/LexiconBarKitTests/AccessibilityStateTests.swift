import XCTest
@testable import LexiconBarKit

final class AccessibilityStateTests: XCTestCase {
    private let epoch = Date(timeIntervalSince1970: 1_800_000_000)

    private func state(trusted: Bool = true,
                       at date: Date? = nil,
                       running: Bool = true) -> AccessibilityState {
        AccessibilityState(axTrusted: trusted, pid: 4242, updatedAt: date ?? epoch,
                           running: running, version: "0.4.1")
    }

    // MARK: the record on disk

    func testRoundTrip() throws {
        let original = state()
        let decoded = try AccessibilityStateStore.decode(AccessibilityStateStore.encode(original))
        XCTAssertEqual(decoded, original)
    }

    func testRoundTripWithoutVersion() throws {
        let original = AccessibilityState(axTrusted: false, pid: 1, updatedAt: epoch, running: false)
        let decoded = try AccessibilityStateStore.decode(AccessibilityStateStore.encode(original))
        XCTAssertEqual(decoded, original)
        XCTAssertNil(decoded.version)
    }

    /// The file is meant to be read by hand and by other tools, so the key
    /// names and the ISO 8601 date are part of the contract.
    func testEncodedShape() throws {
        let json = String(decoding: try AccessibilityStateStore.encode(state()), as: UTF8.self)
        XCTAssertTrue(json.contains("\"axTrusted\" : true"), json)
        XCTAssertTrue(json.contains("\"pid\" : 4242"), json)
        XCTAssertTrue(json.contains("\"running\" : true"), json)
        XCTAssertTrue(json.contains("\"version\" : \"0.4.1\""), json)
        XCTAssertTrue(json.contains("2027-01-15T"), json)
    }

    func testDecodesHandWrittenJSON() throws {
        let data = Data("""
        {"axTrusted":false,"pid":99,"running":true,"updatedAt":"2027-01-15T14:40:00Z"}
        """.utf8)
        let decoded = try AccessibilityStateStore.decode(data)
        XCTAssertFalse(decoded.axTrusted)
        XCTAssertEqual(decoded.pid, 99)
        XCTAssertTrue(decoded.running)
        XCTAssertNil(decoded.version)
    }

    func testGarbageDecodesToNil() {
        XCTAssertThrowsError(try AccessibilityStateStore.decode(Data("not json".utf8)))
    }

    // MARK: staleness

    func testFreshRecordIsLive() {
        let record = state(at: epoch)
        XCTAssertFalse(record.isStale(now: epoch.addingTimeInterval(29)))
        XCTAssertTrue(record.isLive(now: epoch.addingTimeInterval(29)))
        XCTAssertEqual(record.age(now: epoch.addingTimeInterval(29)), 29)
    }

    /// Exactly at the boundary still counts as fresh; a second past it does not.
    func testStalenessBoundary() {
        let record = state(at: epoch)
        XCTAssertFalse(record.isStale(now: epoch.addingTimeInterval(300)))
        XCTAssertTrue(record.isStale(now: epoch.addingTimeInterval(301)))
        XCTAssertFalse(record.isLive(now: epoch.addingTimeInterval(301)))
    }

    /// A clock that moved backwards must not produce a record from the future.
    func testNegativeAgeClampsToZero() {
        let record = state(at: epoch)
        XCTAssertEqual(record.age(now: epoch.addingTimeInterval(-500)), 0)
        XCTAssertFalse(record.isStale(now: epoch.addingTimeInterval(-500)))
    }

    /// The record written on the way out is fresh but not live.
    func testQuitRecordIsNotLive() {
        let record = state(at: epoch, running: false)
        XCTAssertFalse(record.isStale(now: epoch.addingTimeInterval(5)))
        XCTAssertFalse(record.isLive(now: epoch.addingTimeInterval(5)))
    }

    // MARK: writing

    func testWriteIsAtomicAndPrivate() throws {
        let directory = NSTemporaryDirectory() + "lexiconbar-state-\(UUID().uuidString)/nested"
        let path = directory + "/state.json"
        try AccessibilityStateStore.write(state(), path: path)
        defer { try? FileManager.default.removeItem(atPath: directory) }

        let attributes = try FileManager.default.attributesOfItem(atPath: path)
        XCTAssertEqual(attributes[.posixPermissions] as? NSNumber, 0o600)
        XCTAssertEqual(AccessibilityStateStore.read(path: path), state())
        // No temporary file is left behind.
        let left = try FileManager.default.contentsOfDirectory(atPath: directory)
        XCTAssertEqual(left, ["state.json"])
    }

    func testWriteReplacesAnExistingRecord() throws {
        let directory = NSTemporaryDirectory() + "lexiconbar-state-\(UUID().uuidString)"
        let path = directory + "/state.json"
        try AccessibilityStateStore.write(state(trusted: false), path: path)
        try AccessibilityStateStore.write(state(trusted: true), path: path)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        XCTAssertEqual(AccessibilityStateStore.read(path: path)?.axTrusted, true)
        XCTAssertEqual(try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? NSNumber, 0o600)
    }

    func testReadOfAMissingOrCorruptFileIsNil() throws {
        let directory = NSTemporaryDirectory() + "lexiconbar-state-\(UUID().uuidString)"
        try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(atPath: directory) }
        XCTAssertNil(AccessibilityStateStore.read(path: directory + "/nothing.json"))
        let corrupt = directory + "/corrupt.json"
        try Data("{".utf8).write(to: URL(fileURLWithPath: corrupt))
        XCTAssertNil(AccessibilityStateStore.read(path: corrupt))
    }

    func testDisplayPathShortensHome() {
        XCTAssertEqual(AccessibilityStateStore.displayPath(home: "/Users/x"),
                       "~/Library/Application Support/LexiconBar/state.json")
        XCTAssertEqual(AccessibilityStateStore.path(home: "/Users/x"),
                       "/Users/x/Library/Application Support/LexiconBar/state.json")
    }

    // MARK: the write throttle

    func testThrottleWritesFirstThenWaits() {
        var throttle = AccessibilityStateThrottle()
        XCTAssertTrue(throttle.shouldWrite(trusted: true, now: epoch))
        XCTAssertFalse(throttle.shouldWrite(trusted: true, now: epoch.addingTimeInterval(1)))
        XCTAssertFalse(throttle.shouldWrite(trusted: true, now: epoch.addingTimeInterval(29.9)))
        XCTAssertTrue(throttle.shouldWrite(trusted: true, now: epoch.addingTimeInterval(30)))
    }

    /// The moment the user comes back from System Settings is worth a write
    /// whatever the heartbeat says.
    func testThrottleAlwaysWritesAChangedValue() {
        var throttle = AccessibilityStateThrottle()
        XCTAssertTrue(throttle.shouldWrite(trusted: false, now: epoch))
        XCTAssertTrue(throttle.shouldWrite(trusted: true, now: epoch.addingTimeInterval(0.5)))
        XCTAssertFalse(throttle.shouldWrite(trusted: true, now: epoch.addingTimeInterval(1)))
    }

    /// Launch, watcher start and watcher stop write regardless.
    func testThrottleForceAlwaysWrites() {
        var throttle = AccessibilityStateThrottle()
        XCTAssertTrue(throttle.shouldWrite(trusted: true, now: epoch))
        XCTAssertTrue(throttle.shouldWrite(trusted: true, now: epoch, force: true))
        XCTAssertTrue(throttle.shouldWrite(trusted: true, now: epoch, force: true))
    }

    /// The heartbeat is measured from the last write, not from the last check.
    func testThrottleMeasuresFromTheLastWrite() {
        var throttle = AccessibilityStateThrottle()
        XCTAssertTrue(throttle.shouldWrite(trusted: true, now: epoch))
        XCTAssertFalse(throttle.shouldWrite(trusted: true, now: epoch.addingTimeInterval(20)))
        XCTAssertTrue(throttle.shouldWrite(trusted: true, now: epoch.addingTimeInterval(30)))
        XCTAssertFalse(throttle.shouldWrite(trusted: true, now: epoch.addingTimeInterval(45)))
        XCTAssertTrue(throttle.shouldWrite(trusted: true, now: epoch.addingTimeInterval(60)))
    }

    // MARK: which launches can answer for themselves

    /// Only a launchd-parented process with no controlling terminal answers
    /// for itself. That is what `open`, a double-click and a login item look
    /// like; everything else inherits somebody's grant.
    func testLaunchDetection() {
        // A window-server launch: parent is launchd, no tty.
        XCTAssertFalse(AccessibilityReport.isTerminalLaunched(parentPID: 1, hasTTY: false))
        // A human in Terminal.app.
        XCTAssertTrue(AccessibilityReport.isTerminalLaunched(parentPID: 4321, hasTTY: true))
        // The case that caught the first version of this check out: a shell
        // script, a CI job or an agent harness, piped on every descriptor and
        // holding no terminal at all, still inherits the shell's grant.
        XCTAssertTrue(AccessibilityReport.isTerminalLaunched(parentPID: 4321, hasTTY: false))
        // An orphan reparented to launchd but still holding a terminal.
        XCTAssertTrue(AccessibilityReport.isTerminalLaunched(parentPID: 1, hasTTY: true))
    }

    // MARK: the status lines

    private func report(rawTrusted: Bool = true,
                        terminal: Bool,
                        state: AccessibilityState? = nil,
                        after seconds: TimeInterval = 0) -> AccessibilityReport {
        AccessibilityReport.make(rawTrusted: rawTrusted,
                                 terminalLaunched: terminal,
                                 state: state,
                                 now: epoch.addingTimeInterval(seconds),
                                 statePath: "~/Library/Application Support/LexiconBar/state.json")
    }

    /// The bug this whole file exists for: a terminal-launched run must never
    /// print a bare truthy "Accessibility: trusted".
    func testTerminalLaunchedNeverClaimsTrust() {
        let line = report(rawTrusted: true, terminal: true).processLine
        XCTAssertEqual(line, "Accessibility: cannot be checked from a terminal (this process inherits the terminal's grant). The menu bar app's own state is in Set up Lexicon.")
        XCTAssertFalse(line.contains("Accessibility: trusted"))
    }

    func testTerminalLaunchedReportsNullAndKeepsTheRawValue() {
        let terminal = report(rawTrusted: true, terminal: true)
        XCTAssertNil(terminal.processTrusted)
        XCTAssertTrue(terminal.rawTrusted)
        XCTAssertEqual(terminal.note, AccessibilityReport.terminalNote)
        // The same invocation launched by the window server answers for itself.
        let gui = report(rawTrusted: true, terminal: false)
        XCTAssertEqual(gui.processTrusted, true)
        XCTAssertNil(gui.note)
    }

    func testGUILaunchedLines() {
        XCTAssertEqual(report(rawTrusted: true, terminal: false).processLine,
                       "Accessibility: trusted")
        XCTAssertEqual(report(rawTrusted: false, terminal: false).processLine,
                       "Accessibility: not trusted (System Settings > Privacy & Security > Accessibility)")
    }

    func testAppNotRunningWhenThereIsNoStateFile() {
        let missing = report(terminal: true, state: nil)
        XCTAssertEqual(missing.appLine,
                       "Accessibility (menu bar app): not running (no state file at ~/Library/Application Support/LexiconBar/state.json)")
        XCTAssertNil(missing.appTrusted)
        XCTAssertFalse(missing.appRunning)
        XCTAssertNil(missing.stateAge)
    }

    func testAppTrustedLine() {
        let live = report(terminal: true, state: state(trusted: true), after: 8)
        XCTAssertEqual(live.appLine, "Accessibility (menu bar app): trusted (as of 8 seconds ago)")
        XCTAssertEqual(live.appTrusted, true)
        XCTAssertTrue(live.appRunning)
        XCTAssertEqual(live.stateAge, 8)
    }

    func testAppNotGrantedLine() {
        let live = report(terminal: true, state: state(trusted: false), after: 61)
        XCTAssertEqual(live.appLine,
                       "Accessibility (menu bar app): not granted (as of 1 minute ago). Add LexiconBar.app under System Settings > Privacy & Security > Accessibility")
        XCTAssertEqual(live.appTrusted, false)
        XCTAssertTrue(live.appRunning)
    }

    func testStaleRecordReadsAsNotRunning() {
        let stale = report(terminal: true, state: state(trusted: true), after: 9 * 60)
        XCTAssertEqual(stale.appLine, "Accessibility (menu bar app): not running (last heartbeat 9 minutes ago)")
        XCTAssertNil(stale.appTrusted)
        XCTAssertFalse(stale.appRunning)
    }

    func testQuitRecordReadsAsNotRunning() {
        let quit = report(terminal: true, state: state(trusted: true, running: false), after: 30)
        XCTAssertEqual(quit.appLine, "Accessibility (menu bar app): not running (it quit 30 seconds ago)")
        XCTAssertNil(quit.appTrusted)
        XCTAssertFalse(quit.appRunning)
    }

    /// From a terminal the exit code follows the running app, since this
    /// process's own answer means nothing.
    func testEffectiveTrusted() {
        XCTAssertFalse(report(rawTrusted: true, terminal: true, state: nil).effectiveTrusted)
        XCTAssertTrue(report(rawTrusted: true, terminal: true, state: state(trusted: true)).effectiveTrusted)
        XCTAssertFalse(report(rawTrusted: true, terminal: true, state: state(trusted: false)).effectiveTrusted)
        // A stale record is no evidence either way.
        XCTAssertFalse(report(rawTrusted: true, terminal: true, state: state(trusted: true), after: 600).effectiveTrusted)
        // Launched by the window server: its own answer wins over the file.
        XCTAssertTrue(report(rawTrusted: true, terminal: false, state: state(trusted: false)).effectiveTrusted)
        XCTAssertFalse(report(rawTrusted: false, terminal: false, state: state(trusted: true)).effectiveTrusted)
    }

    func testRelativeAge() {
        XCTAssertEqual(AccessibilityReport.relativeAge(0), "just now")
        XCTAssertEqual(AccessibilityReport.relativeAge(0.4), "just now")
        XCTAssertEqual(AccessibilityReport.relativeAge(1), "1 second ago")
        XCTAssertEqual(AccessibilityReport.relativeAge(12), "12 seconds ago")
        XCTAssertEqual(AccessibilityReport.relativeAge(59), "59 seconds ago")
        XCTAssertEqual(AccessibilityReport.relativeAge(60), "1 minute ago")
        XCTAssertEqual(AccessibilityReport.relativeAge(119), "1 minute ago")
        XCTAssertEqual(AccessibilityReport.relativeAge(120), "2 minutes ago")
        XCTAssertEqual(AccessibilityReport.relativeAge(3600), "1 hour ago")
        XCTAssertEqual(AccessibilityReport.relativeAge(7200), "2 hours ago")
        XCTAssertEqual(AccessibilityReport.relativeAge(86_400), "1 day ago")
        XCTAssertEqual(AccessibilityReport.relativeAge(4 * 86_400), "4 days ago")
    }
}
