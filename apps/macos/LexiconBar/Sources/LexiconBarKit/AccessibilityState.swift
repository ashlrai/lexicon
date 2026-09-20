import Foundation

/// Accessibility trust, reported honestly.
///
/// `AXIsProcessTrusted()` does not answer "is LexiconBar allowed to use
/// Accessibility". It answers for the *responsible process*, and for anything
/// spawned from a shell that is the terminal. So a `--status` run from a
/// terminal inherits the terminal's grant: the freshly built
/// `.build/release/LexiconBar`, which cannot hold a grant of its own, happily
/// reported `axTrusted: true` while the unified log showed the GUI-launched
/// bundle being denied (`kTCCServiceAccessibility auth_value: 0`). Someone
/// debugging with `--status` was told the opposite of the truth.
///
/// Two things fix that, and both live here as pure functions:
///
/// 1. A terminal-launched invocation refuses to report its own
///    `AXIsProcessTrusted()` as if it meant anything (`axTrusted: null`, the
///    raw value kept as `axTrustedRaw`).
/// 2. The running menu bar app writes its own answer to
///    `~/Library/Application Support/LexiconBar/state.json`, which `--status`
///    reads. That file is the one a user or an agent should believe.

/// One heartbeat record from the running app.
///
/// `running` is false in the record written on the way out, so a quit app
/// reads as gone immediately instead of waiting out `staleAfter`.
public struct AccessibilityState: Equatable, Sendable, Codable {
    /// `AXIsProcessTrusted()` as seen by the GUI-launched app — the answer
    /// that actually governs Fix everywhere.
    public var axTrusted: Bool
    /// The app's pid, so a stale file can be told apart from a live one by hand.
    public var pid: Int32
    /// When this record was written.
    public var updatedAt: Date
    /// False in the final record written as the app terminates.
    public var running: Bool
    /// `CFBundleShortVersionString`, when the app is bundled.
    public var version: String?

    public init(axTrusted: Bool,
                pid: Int32,
                updatedAt: Date,
                running: Bool = true,
                version: String? = nil) {
        self.axTrusted = axTrusted
        self.pid = pid
        self.updatedAt = updatedAt
        self.running = running
        self.version = version
    }

    /// Seconds since this record was written (never negative: a clock that
    /// moved backwards reads as 0 rather than as a record from the future).
    public func age(now: Date) -> TimeInterval {
        max(0, now.timeIntervalSince(updatedAt))
    }

    /// True when the record is too old to be believed. The app rewrites it
    /// every `heartbeat` seconds, so anything older than `staleAfter` means
    /// the app is gone (force-quit, crashed, or never launched).
    public func isStale(now: Date, staleAfter: TimeInterval = AccessibilityStateStore.staleAfter) -> Bool {
        age(now: now) > staleAfter
    }

    /// True when this record describes an app that is up right now.
    public func isLive(now: Date, staleAfter: TimeInterval = AccessibilityStateStore.staleAfter) -> Bool {
        running && !isStale(now: now, staleAfter: staleAfter)
    }
}

/// Where the state file lives, how it is encoded, and how it is written.
public enum AccessibilityStateStore {
    /// `~/Library/Application Support/LexiconBar`.
    public static let directory = "Library/Application Support/LexiconBar"
    public static let fileName = "state.json"
    /// Older than this and the app is assumed gone.
    public static let staleAfter: TimeInterval = 300
    /// The app refreshes the file this often while it runs.
    public static let heartbeat: TimeInterval = 30

    public static func path(home: String = NSHomeDirectory()) -> String {
        ((home as NSString).appendingPathComponent(directory) as NSString)
            .appendingPathComponent(fileName)
    }

    /// `~`-shortened, for printing.
    public static func displayPath(home: String = NSHomeDirectory()) -> String {
        let full = path(home: home)
        guard full.hasPrefix(home) else { return full }
        return "~" + full.dropFirst(home.count)
    }

    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys, .prettyPrinted]
        return encoder
    }

    private static var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    public static func encode(_ state: AccessibilityState) throws -> Data {
        try encoder.encode(state)
    }

    public static func decode(_ data: Data) throws -> AccessibilityState {
        try decoder.decode(AccessibilityState.self, from: data)
    }

    /// The record on disk, or nil when there is no readable one. A file that
    /// cannot be parsed is treated exactly like a missing one: the app is not
    /// telling us anything we can use.
    public static func read(path: String = AccessibilityStateStore.path()) -> AccessibilityState? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return try? decode(data)
    }

    /// Writes the record atomically with mode 0600.
    ///
    /// The bytes go to a temporary file in the same directory (created 0600,
    /// so the contents are never briefly world-readable) and are moved into
    /// place with `rename(2)`, which is atomic within a filesystem and works
    /// whether or not the destination already exists. A reader therefore sees
    /// either the old record or the new one, never half of either.
    public static func write(_ state: AccessibilityState,
                             path: String = AccessibilityStateStore.path()) throws {
        let data = try encode(state)
        let directory = (path as NSString).deletingLastPathComponent
        try FileManager.default.createDirectory(atPath: directory,
                                                withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        let temporary = (directory as NSString)
            .appendingPathComponent(".\(fileName).\(getpid()).tmp")
        guard FileManager.default.createFile(atPath: temporary,
                                             contents: data,
                                             attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown)
        }
        guard rename(temporary, path) == 0 else {
            let code = errno
            try? FileManager.default.removeItem(atPath: temporary)
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(code))
        }
    }

    public static func remove(path: String = AccessibilityStateStore.path()) {
        try? FileManager.default.removeItem(atPath: path)
    }
}

/// Decides when the running app should rewrite the state file.
///
/// The app writes on launch, when the focus watcher starts or stops, and
/// otherwise no more than once every `heartbeat` seconds — except that a
/// *change* in the trust value is always worth writing immediately, since
/// that is the moment the user came back from System Settings.
public struct AccessibilityStateThrottle: Equatable, Sendable {
    public let heartbeat: TimeInterval
    public private(set) var lastWrite: Date?
    public private(set) var lastTrusted: Bool?

    public init(heartbeat: TimeInterval = AccessibilityStateStore.heartbeat) {
        self.heartbeat = heartbeat
    }

    /// Call before every write. Returns true when the write should happen,
    /// and records it. `force` is the launch / watcher-start / watcher-stop
    /// case, which always writes.
    public mutating func shouldWrite(trusted: Bool, now: Date, force: Bool = false) -> Bool {
        let due: Bool
        if force || lastWrite == nil || trusted != lastTrusted {
            due = true
        } else if let lastWrite {
            due = now.timeIntervalSince(lastWrite) >= heartbeat
        } else {
            due = true
        }
        guard due else { return false }
        lastWrite = now
        lastTrusted = trusted
        return true
    }
}

/// The exact words `--status` prints, per launch mode and per state file.
public struct AccessibilityReport: Equatable, Sendable {
    /// The `Accessibility:` line — what this invocation can honestly say
    /// about itself.
    public let processLine: String
    /// The `Accessibility (menu bar app):` line — what the running app says
    /// about itself, which is the answer that matters.
    public let appLine: String
    /// True when this invocation came from a terminal and its own
    /// `AXIsProcessTrusted()` is therefore the terminal's answer.
    public let terminalLaunched: Bool
    /// `AXIsProcessTrusted()` as this process saw it, meaningful only when
    /// `terminalLaunched` is false.
    public let rawTrusted: Bool
    /// `nil` from a terminal: this process cannot know.
    public var processTrusted: Bool? { terminalLaunched ? nil : rawTrusted }
    /// The running app's own answer; nil when no live app said anything.
    public let appTrusted: Bool?
    /// True when a live, fresh record was found.
    public let appRunning: Bool
    /// Age of the record in seconds, when there was one.
    public let stateAge: TimeInterval?
    /// Why `axTrusted` is null, for the JSON form. Nil when it is not null.
    public let note: String?

    public init(processLine: String, appLine: String, terminalLaunched: Bool, rawTrusted: Bool,
                appTrusted: Bool?, appRunning: Bool, stateAge: TimeInterval?, note: String?) {
        self.processLine = processLine
        self.appLine = appLine
        self.terminalLaunched = terminalLaunched
        self.rawTrusted = rawTrusted
        self.appTrusted = appTrusted
        self.appRunning = appRunning
        self.stateAge = stateAge
        self.note = note
    }

    /// The trust value the exit code should be built from: this process's own
    /// when it is meaningful, otherwise the running app's, otherwise false.
    public var effectiveTrusted: Bool {
        processTrusted ?? appTrusted ?? false
    }

    /// Whether this invocation is one whose `AXIsProcessTrusted()` belongs to
    /// somebody else.
    ///
    /// Two signals, because either one alone is wrong:
    ///
    /// - `hasTTY` catches the interactive case, a human typing `--status` in
    ///   Terminal. It is not enough on its own: a shell script, a CI job and
    ///   an agent harness all run with pipes for stdin/stdout/stderr and no
    ///   controlling terminal, and every one of them still inherits the
    ///   responsible process's grant. This was not theoretical — the first
    ///   cut of this check used `isatty` alone and promptly printed
    ///   "Accessibility: trusted" from a pipe-only shell while the GUI app
    ///   was being denied, which is the exact bug it was written to fix.
    /// - `parentPID == 1` is what a window-server launch looks like:
    ///   LaunchServices has launchd spawn the app, so `open`, a login item
    ///   and a double-click all report launchd as the parent. Anything else
    ///   is a parent that could be responsible for us.
    ///
    /// The bias is deliberate: an unusual launch is called a terminal launch
    /// and reports nothing rather than reporting something that may be a lie.
    /// The cost of a false "terminal" is one extra line of output; the cost
    /// of a false "GUI" is the wrong answer.
    public static func isTerminalLaunched(parentPID: Int32, hasTTY: Bool) -> Bool {
        hasTTY || parentPID != 1
    }

    public static let terminalNote =
        "AXIsProcessTrusted() answers for the responsible process, which for a terminal-launched run is the terminal, not LexiconBar. Read axAppTrusted instead."

    public static let terminalLine =
        "Accessibility: cannot be checked from a terminal (this process inherits the terminal's grant). The menu bar app's own state is in Set up Lexicon."

    /// Builds both lines.
    ///
    /// - Parameters:
    ///   - rawTrusted: `AXIsProcessTrusted()` in this process.
    ///   - terminalLaunched: stdin or stderr is a TTY.
    ///   - state: the record read from the state file, if any.
    ///   - now: for the relative time.
    ///   - statePath: printed when there is no file, so the reader knows where to look.
    public static func make(rawTrusted: Bool,
                            terminalLaunched: Bool,
                            state: AccessibilityState?,
                            now: Date,
                            statePath: String,
                            staleAfter: TimeInterval = AccessibilityStateStore.staleAfter) -> AccessibilityReport {
        let processLine: String
        if terminalLaunched {
            processLine = terminalLine
        } else if rawTrusted {
            processLine = "Accessibility: trusted"
        } else {
            processLine = "Accessibility: not trusted (System Settings > Privacy & Security > Accessibility)"
        }

        let prefix = "Accessibility (menu bar app): "
        guard let state else {
            return AccessibilityReport(
                processLine: processLine,
                appLine: prefix + "not running (no state file at \(statePath))",
                terminalLaunched: terminalLaunched,
                rawTrusted: rawTrusted,
                appTrusted: nil,
                appRunning: false,
                stateAge: nil,
                note: terminalLaunched ? terminalNote : nil)
        }

        let age = state.age(now: now)
        let ago = relativeAge(age)
        let appLine: String
        var appTrusted: Bool?
        var appRunning = false
        if !state.running {
            appLine = prefix + "not running (it quit \(ago))"
        } else if state.isStale(now: now, staleAfter: staleAfter) {
            appLine = prefix + "not running (last heartbeat \(ago))"
        } else {
            appRunning = true
            appTrusted = state.axTrusted
            if state.axTrusted {
                appLine = prefix + "trusted (as of \(ago))"
            } else {
                appLine = prefix + "not granted (as of \(ago)) \u{2014} add LexiconBar.app under System Settings > Privacy & Security > Accessibility"
            }
        }

        return AccessibilityReport(
            processLine: processLine,
            appLine: appLine,
            terminalLaunched: terminalLaunched,
            rawTrusted: rawTrusted,
            appTrusted: appTrusted,
            appRunning: appRunning,
            stateAge: age,
            note: terminalLaunched ? terminalNote : nil)
    }

    /// "just now", "12 seconds ago", "3 minutes ago", "2 hours ago", "4 days ago".
    /// Coarse on purpose: the reader only needs to know whether the record is
    /// from this moment or from last week.
    public static func relativeAge(_ seconds: TimeInterval) -> String {
        let whole = Int(seconds.rounded())
        switch whole {
        case ..<1: return "just now"
        case ..<60: return plural(whole, "second")
        case ..<3600: return plural(whole / 60, "minute")
        case ..<86_400: return plural(whole / 3600, "hour")
        default: return plural(whole / 86_400, "day")
        }
    }

    private static func plural(_ count: Int, _ unit: String) -> String {
        "\(count) \(unit)\(count == 1 ? "" : "s") ago"
    }
}
