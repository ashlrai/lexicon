import Foundation
import LexiconBarKit

/// Keeps one long-running `lexicon` child (`daemon` or `serve`) alive while
/// the user wants it. Unexpected exits are retried per `RestartPolicy`
/// (5 s backoff, 5 restarts, counter reset after a minute of uptime). The
/// child is killed on stop and on app quit.
@MainActor
final class ChildProcessSupervisor {
    enum State: Equatable {
        case stopped
        case running(pid: Int32)
        case restarting(in: TimeInterval)
        /// The restart budget is spent; `lastError` explains.
        case failed(String)
    }

    let name: String
    let arguments: [String]
    private let cli: LexiconCLI
    private var policy: RestartPolicy
    private var process: Process?
    private var startedAt: Date?
    private var wanted = false
    private var restartTimer: Timer?
    private var stderrTail = ""

    private(set) var state: State = .stopped {
        didSet { if state != oldValue { onStateChange?(state) } }
    }
    var onStateChange: ((State) -> Void)?

    init(name: String, arguments: [String], cli: LexiconCLI, policy: RestartPolicy = RestartPolicy()) {
        self.name = name
        self.arguments = arguments
        self.cli = cli
        self.policy = policy
    }

    var isRunning: Bool {
        if case .running = state { return true }
        return false
    }

    func start() {
        wanted = true
        policy.reset()
        launch()
    }

    func stop() {
        wanted = false
        restartTimer?.invalidate()
        restartTimer = nil
        terminateChild()
        state = .stopped
    }

    /// Synchronous kill for app termination.
    func terminateChild() {
        guard let process, process.isRunning else { self.process = nil; return }
        process.terminationHandler = nil
        process.terminate()
        // Give node a moment to exit cleanly, then force it.
        let deadline = Date().addingTimeInterval(1.5)
        while process.isRunning && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        self.process = nil
    }

    private func launch() {
        guard wanted else { return }
        guard let process = cli.makeChildProcess(arguments) else {
            state = .failed("lexicon CLI not found")
            return
        }
        let errPipe = Pipe()
        process.standardError = errPipe
        process.standardOutput = FileHandle.nullDevice
        stderrTail = ""
        errPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            let text = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async {
                guard let self else { return }
                self.stderrTail = String((self.stderrTail + text).suffix(2000))
            }
        }
        process.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                errPipe.fileHandleForReading.readabilityHandler = nil
                self?.childExited(proc)
            }
        }
        do {
            try process.run()
        } catch {
            state = .failed("Could not launch lexicon \(arguments.joined(separator: " ")): \(error.localizedDescription)")
            wanted = false
            return
        }
        self.process = process
        startedAt = Date()
        state = .running(pid: process.processIdentifier)
    }

    private func childExited(_ proc: Process) {
        guard proc === process else { return } // an older child we already replaced
        process = nil
        guard wanted else { state = .stopped; return }
        let uptime = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        let reason = stderrTail.trimmingCharacters(in: .whitespacesAndNewlines)
        if let delay = policy.delayBeforeRestart(afterUptime: uptime) {
            NSLog("LexiconBar: lexicon %@ exited (%d); restarting in %.0fs", name, proc.terminationStatus, delay)
            state = .restarting(in: delay)
            restartTimer?.invalidate()
            restartTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
                DispatchQueue.main.async { self?.launch() }
            }
        } else {
            wanted = false
            let detail = reason.isEmpty ? "exit code \(proc.terminationStatus)" : reason
            state = .failed("lexicon \(name) kept exiting (\(detail)). Gave up after \(policy.maxRestarts) restarts.")
        }
    }
}
