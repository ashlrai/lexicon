import Foundation
import LexiconBarKit

/// Gathers the four facts behind `ServeOwnership.resolve` and caches them.
///
/// Two of the probes are slow enough to matter — `launchctl print` forks a
/// process and `GET /health` is a network round trip — and the menu rebuilds on
/// every open, so the answer is cached for `ttl` and refreshed off the main
/// thread. Callers read the cached `status(appChildRunning:)` synchronously and
/// get told through `onChange` when a refresh moved it.
@MainActor
final class ServeOwnershipMonitor {
    /// How long a probe result is trusted before the next read re-runs it.
    static let ttl: TimeInterval = 5

    private let runner: CommandRunner
    private let credentials: NormalizeClient
    private let label: String
    private let home: String
    private let uid: uid_t

    /// Everything but `appChildRunning`, which the caller owns and which is
    /// free to read, so it is folded in at `status(appChildRunning:)` time.
    private var probe: ServeProbe
    private var lastProbe: Date?
    private var inFlight = false
    /// Callbacks waiting for the refresh that is currently running.
    private var waiting: [() -> Void] = []

    /// Called on the main thread when a refresh changed the answer.
    var onChange: (() -> Void)?

    init(runner: CommandRunner,
         credentials: NormalizeClient,
         label: String = ProcessInfo.processInfo.environment["LEXICON_SERVE_LABEL"].flatMap {
             let trimmed = $0.trimmingCharacters(in: .whitespaces)
             return trimmed.range(of: "^[A-Za-z0-9._-]+$", options: .regularExpression) != nil ? trimmed : nil
         } ?? ServeOwnership.defaultLabel,
         home: String = FileManager.default.homeDirectoryForCurrentUser.path,
         uid: uid_t = getuid()) {
        self.runner = runner
        self.credentials = credentials
        self.label = label
        self.home = home
        self.uid = uid
        probe = ServeProbe(label: label, port: credentials.credentials()?.port ?? ServeOwnership.defaultPort)
    }

    /// The current answer, from the cache. Never blocks.
    func status(appChildRunning: Bool) -> ServeStatus {
        var current = probe
        current.appChildRunning = appChildRunning
        return ServeOwnership.resolve(current)
    }

    var isStale: Bool {
        guard let lastProbe else { return true }
        return Date().timeIntervalSince(lastProbe) >= ServeOwnershipMonitor.ttl
    }

    /// Re-probes when the cache has expired (or always, with `force`). Safe to
    /// call from a menu rebuild: it returns at once and reports through `onChange`.
    func refreshIfStale(force: Bool = false) {
        guard force || isStale else { return }
        refresh()
    }

    /// Makes sure the cache is fresh, then calls `completion` on the main
    /// thread. With a fresh cache the completion runs immediately.
    func whenFresh(force: Bool = false, _ completion: @escaping () -> Void) {
        guard force || isStale else { completion(); return }
        waiting.append(completion)
        refresh()
    }

    private func refresh() {
        guard !inFlight else { return }
        inFlight = true
        ServeOwnershipMonitor.probeOffMain(runner: runner, credentials: credentials,
                                           label: label, home: home, uid: uid) { [weak self] next in
            self?.finish(next)
        }
    }

    /// The three real probes, off the main thread. Nothing here touches the
    /// monitor, so it can stay a free function and hop back with the answer.
    private nonisolated static func probeOffMain(runner: CommandRunner,
                                                 credentials: NormalizeClient,
                                                 label: String,
                                                 home: String,
                                                 uid: uid_t,
                                                 completion: @escaping @MainActor (ServeProbe) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let next = probeSync(runner: runner, credentials: credentials, label: label, home: home, uid: uid)
            DispatchQueue.main.async { completion(next) }
        }
    }

    /// The three probes, blocking. `appChildRunning` is left false: only the
    /// running app knows that, and `--status` is a separate process.
    /// Never call this on the main thread of the running app.
    nonisolated static func probeSync(runner: CommandRunner,
                                      credentials: NormalizeClient,
                                      label: String = ServeOwnership.defaultLabel,
                                      home: String = FileManager.default.homeDirectoryForCurrentUser.path,
                                      uid: uid_t = getuid()) -> ServeProbe {
        // `launchctl print gui/<uid>/<label>` exits 0 only for a label that is
        // actually loaded into the user's domain; a plist on disk that was
        // never bootstrapped exits non-zero.
        let printed = runner.runSync(executable: URL(fileURLWithPath: "/bin/launchctl"),
                                     arguments: ["print", "gui/\(uid)/\(label)"],
                                     timeout: 5)
        let loaded = printed.launchError == nil && !printed.timedOut && printed.exitCode == 0

        let plistPath = ServeOwnership.launchAgentPlistPath(home: home, label: label)
        let plistData = FileManager.default.contents(atPath: plistPath)
        let programPath = plistData.flatMap { ServeOwnership.programPath(fromPlist: $0) }

        let port = credentials.credentials()?.port ?? ServeOwnership.defaultPort
        let reachable: Bool
        if case .success = credentials.healthSync(timeout: 2) { reachable = true } else { reachable = false }

        return ServeProbe(launchdLoaded: loaded,
                          plistExists: plistData != nil,
                          apiReachable: reachable,
                          appChildRunning: false,
                          label: label,
                          programPath: programPath,
                          port: port)
    }

    private func finish(_ next: ServeProbe) {
        inFlight = false
        lastProbe = Date()
        let changed = next != probe
        probe = next
        let pending = waiting
        waiting = []
        for callback in pending { callback() }
        if changed { onChange?() }
    }
}
