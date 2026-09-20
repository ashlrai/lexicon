import Foundation

/// Who is actually running `lexicon serve` right now.
///
/// The menu's "Local API" row and the first-run window's step 4 used to show
/// whether *this app* was supervising a `lexicon serve` child, which is only
/// one of four ways the local API can be up. On a machine where the LaunchAgent
/// owns it the row read "off" while the API was plainly answering, and ticking
/// it would have started a second server that cannot bind the port.
///
/// `resolve` turns four observable facts into the case and the words the UI
/// should use, so the menu and the onboarding row can never disagree.
public enum ServeOwnership: Equatable, Sendable {
    /// A launchd LaunchAgent owns it: it started at login and will be restarted
    /// by launchd. `programPath` is the script the plist runs, when it could be read.
    case launchAgent(label: String, programPath: String?)
    /// This app spawned and supervises the `lexicon serve` child.
    case appChild
    /// Something is listening on the port that is neither of the above — a
    /// `lexicon serve` run by hand in a terminal, or an unrelated process.
    case foreign
    /// Nothing is serving.
    case none

    /// The launchd label `lexicon serve --install` writes (src/cli/serve-paths.ts).
    public static let defaultLabel = "ai.ashlr.lexicon.serve"
    /// The port `lexicon serve` binds unless told otherwise.
    public static let defaultPort = 41733

    /// `~/Library/LaunchAgents/<label>.plist`.
    public static func launchAgentPlistPath(home: String, label: String = ServeOwnership.defaultLabel) -> String {
        (home as NSString).appendingPathComponent("Library/LaunchAgents/\(label).plist")
    }

    /// True when this app must not start a `lexicon serve` child: someone else
    /// already holds the port, or will take it back the moment we let go.
    public var isOwnedByOther: Bool {
        switch self {
        case .launchAgent, .foreign: return true
        case .appChild, .none: return false
        }
    }
}

/// The facts `ServeOwnership.resolve` reasons over. Everything here is
/// observable without side effects: three of them are a `launchctl print`, a
/// `FileManager.fileExists` and a `GET /health`; the fourth is this app's own
/// supervisor state.
public struct ServeProbe: Equatable, Sendable {
    /// `launchctl print gui/<uid>/<label>` exited 0.
    public var launchdLoaded: Bool
    /// `~/Library/LaunchAgents/<label>.plist` is on disk.
    public var plistExists: Bool
    /// `GET /health` on the port answered.
    public var apiReachable: Bool
    /// This app's `ChildProcessSupervisor` reports a live `lexicon serve`.
    public var appChildRunning: Bool
    public var label: String
    /// The second `ProgramArguments` entry of the plist, when it parsed.
    public var programPath: String?
    public var port: Int

    public init(launchdLoaded: Bool = false,
                plistExists: Bool = false,
                apiReachable: Bool = false,
                appChildRunning: Bool = false,
                label: String = ServeOwnership.defaultLabel,
                programPath: String? = nil,
                port: Int = ServeOwnership.defaultPort) {
        self.launchdLoaded = launchdLoaded
        self.plistExists = plistExists
        self.apiReachable = apiReachable
        self.appChildRunning = appChildRunning
        self.label = label
        self.programPath = programPath
        self.port = port
    }
}

/// The case plus the exact words the menu row and the onboarding row show.
public struct ServeStatus: Equatable, Sendable {
    public let ownership: ServeOwnership
    /// The row's own text: a checkbox label when `isInteractive`, a status line otherwise.
    public let title: String
    /// The second line: the caption under the onboarding toggle, the menu item's tooltip.
    public let detail: String
    /// A subtle extra line — how to change a thing this app does not control.
    public let hint: String?
    /// True when the row is a checkbox the user may click. False means a status
    /// line: something else owns the port and a click could only start a duplicate.
    public let isInteractive: Bool
    /// True when something is serving right now (the checkbox reads "on").
    public let isOn: Bool

    public init(ownership: ServeOwnership, title: String, detail: String,
                hint: String?, isInteractive: Bool, isOn: Bool) {
        self.ownership = ownership
        self.title = title
        self.detail = detail
        self.hint = hint
        self.isInteractive = isInteractive
        self.isOn = isOn
    }
}

extension ServeOwnership {
    /// The truth table, in precedence order:
    ///
    /// | launchd loaded | app child | API reachable | →            |
    /// |----------------|-----------|---------------|--------------|
    /// | yes            | any       | any           | `launchAgent` |
    /// | no             | yes       | any           | `appChild`    |
    /// | no             | no        | yes           | `foreign`     |
    /// | no             | no        | no            | `none`        |
    ///
    /// launchd wins outright: with `KeepAlive` it takes the port back whatever
    /// else happens, so a child of ours would only thrash. A plist on disk that
    /// is *not* loaded is not ownership — it is a hint for the `none` case,
    /// where ticking the box re-installs it.
    public static func resolve(_ probe: ServeProbe) -> ServeStatus {
        if probe.launchdLoaded {
            let ownership = ServeOwnership.launchAgent(label: probe.label, programPath: probe.programPath)
            let program = probe.programPath.map { " running \($0)" } ?? ""
            if probe.apiReachable {
                return ServeStatus(
                    ownership: ownership,
                    title: "Local API: running at login (launchd)",
                    detail: "`\(probe.label)`\(program) owns 127.0.0.1:\(probe.port). This app will not start a second one.",
                    hint: "Manage with `lexicon serve --uninstall`",
                    isInteractive: false,
                    isOn: true)
            }
            return ServeStatus(
                ownership: ownership,
                title: "Local API: installed at login (launchd), not answering",
                detail: "`\(probe.label)`\(program) is loaded but nothing answered on 127.0.0.1:\(probe.port). Check `lexicon serve --status`.",
                hint: "Manage with `lexicon serve --uninstall`",
                isInteractive: false,
                isOn: false)
        }

        if probe.appChildRunning {
            return ServeStatus(
                ownership: .appChild,
                title: "Local API: running (started by this app)",
                detail: "This app supervises `lexicon serve` on 127.0.0.1:\(probe.port) and stops it when you quit.",
                hint: "Install it at login with `lexicon serve --install` to keep it up without the app.",
                isInteractive: true,
                isOn: true)
        }

        if probe.apiReachable {
            return ServeStatus(
                ownership: .foreign,
                title: "Local API: reachable (not managed by this app)",
                detail: "Something else is already listening on 127.0.0.1:\(probe.port) — most likely a `lexicon serve` you started by hand.",
                hint: "Find it with `lsof -nP -iTCP:\(probe.port) -sTCP:LISTEN`",
                isInteractive: false,
                isOn: false)
        }

        return ServeStatus(
            ownership: .none,
            title: "Run the local API",
            detail: "`lexicon serve` on 127.0.0.1:\(probe.port). Fix everywhere and the browser extension both go through it.",
            hint: probe.plistExists
                ? "`\(probe.label)` is installed but not loaded; ticking this loads it again (`lexicon serve --install`)."
                : "Ticking this installs it at login (`lexicon serve --install`) so it survives app restarts.",
            isInteractive: true,
            isOn: false)
    }

    /// The second `ProgramArguments` entry of a launchd plist — the script the
    /// agent runs, which is what tells the user *which* checkout is serving.
    /// The first entry is the node binary. Nil when the file is missing or has
    /// no such array.
    public static func programPath(fromPlist data: Data) -> String? {
        guard let object = try? PropertyListSerialization.propertyList(from: data, format: nil),
              let dict = object as? [String: Any],
              let arguments = dict["ProgramArguments"] as? [String],
              arguments.count >= 2 else { return nil }
        return arguments[1]
    }
}
