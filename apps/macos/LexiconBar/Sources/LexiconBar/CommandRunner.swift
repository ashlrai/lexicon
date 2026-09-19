import Foundation
import LexiconBarKit

/// What a finished CLI call produced.
struct CommandResult {
    let stdout: String
    let stderr: String
    let exitCode: Int32
    let timedOut: Bool
    /// Set when the process could not be launched at all.
    let launchError: String?

    var succeeded: Bool { launchError == nil && !timedOut && exitCode == 0 }

    /// Something short to put in an alert.
    var failureDescription: String {
        if let launchError { return launchError }
        if timedOut { return "Timed out." }
        let err = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        if !err.isEmpty { return err }
        let out = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if !out.isEmpty { return out }
        return "Exit code \(exitCode)."
    }
}

/// Runs the lexicon CLI (or any executable) off the main thread with an
/// argument array, captured output, a timeout, and the augmented PATH so the
/// `#!/usr/bin/env node` shebang resolves. Never builds a shell string.
final class CommandRunner: @unchecked Sendable {
    /// PATH used for children; set once at startup from the login shell.
    var childPATH: String = ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin"

    private let queue = DispatchQueue(label: "ai.ashlr.lexiconbar.commands", qos: .userInitiated, attributes: .concurrent)

    func environment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = childPATH
        env["LEXICON_BAR"] = "1"
        // Keep the CLI from paging or colouring output meant for us.
        env["NO_COLOR"] = "1"
        env["TERM"] = "dumb"
        return env
    }

    /// Runs `executable args...` and calls `completion` on the main thread.
    func run(executable: URL, arguments: [String], timeout: TimeInterval,
             currentDirectory: URL? = nil,
             completion: @escaping @MainActor (CommandResult) -> Void) {
        queue.async {
            let result = self.runSync(executable: executable, arguments: arguments, timeout: timeout, currentDirectory: currentDirectory)
            DispatchQueue.main.async { completion(result) }
        }
    }

    /// Synchronous variant for the calling thread (never call on main).
    func runSync(executable: URL, arguments: [String], timeout: TimeInterval, currentDirectory: URL? = nil) -> CommandResult {
        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.environment = environment()
        if let currentDirectory { process.currentDirectoryURL = currentDirectory }
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        process.standardInput = FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            return CommandResult(stdout: "", stderr: "", exitCode: -1, timedOut: false,
                                 launchError: "Could not launch \(executable.path): \(error.localizedDescription)")
        }

        // Drain both pipes concurrently so a chatty child never blocks on a full pipe.
        let group = DispatchGroup()
        var outData = Data()
        var errData = Data()
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            outData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        group.enter()
        DispatchQueue.global(qos: .utility).async {
            errData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }

        let timedOut = CommandRunner.wait(for: process, timeout: timeout)
        group.wait()

        return CommandResult(
            stdout: String(decoding: outData, as: UTF8.self),
            stderr: String(decoding: errData, as: UTF8.self),
            exitCode: process.terminationStatus,
            timedOut: timedOut,
            launchError: nil
        )
    }

    /// Waits for exit; on timeout sends SIGTERM, then SIGKILL two seconds later.
    private static func wait(for process: Process, timeout: TimeInterval) -> Bool {
        let done = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in done.signal() }
        if process.isRunning == false { return false }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            if done.wait(timeout: .now() + 2) == .timedOut {
                kill(process.processIdentifier, SIGKILL)
                _ = done.wait(timeout: .now() + 2)
            }
            return true
        }
        return false
    }
}

/// Wraps `CommandRunner` with the resolved CLI location and the standard
/// timeouts (60 s for the voice stop call, 10 s for everything else).
@MainActor
final class LexiconCLI {
    nonisolated static let voiceTimeout: TimeInterval = 60
    nonisolated static let defaultTimeout: TimeInterval = 10

    let runner: CommandRunner
    private(set) var location: CLILocation?

    init(runner: CommandRunner) {
        self.runner = runner
    }

    var isAvailable: Bool { location != nil }

    func setLocation(_ location: CLILocation?) {
        self.location = location
    }

    /// Runs `lexicon <arguments>`. The completion always runs on main.
    func run(_ arguments: [String], timeout: TimeInterval = LexiconCLI.defaultTimeout,
             completion: @escaping @MainActor (CommandResult) -> Void) {
        guard let location else {
            completion(CommandResult(stdout: "", stderr: "", exitCode: -1, timedOut: false,
                                     launchError: "The lexicon CLI was not found. Set its path in Preferences."))
            return
        }
        runner.run(executable: location.executableURL, arguments: location.prefixArguments + arguments, timeout: timeout,
                   completion: completion)
    }

    /// Builds a `Process` for a long-running child (`daemon`, `serve`) without starting it.
    func makeChildProcess(_ arguments: [String]) -> Process? {
        guard let location else { return nil }
        let process = Process()
        process.executableURL = location.executableURL
        process.arguments = location.prefixArguments + arguments
        process.environment = runner.environment()
        process.standardInput = FileHandle.nullDevice
        return process
    }
}

/// Resolves the CLI location at launch: asks the login shell for
/// `command -v lexicon` and its PATH (fixed argument strings only), then hands
/// the answers to the pure `CLILocator`.
enum CLIDiscovery {
    struct Outcome {
        let location: CLILocation?
        let loginPath: String?
        let locator: CLILocator
    }

    static func discover(runner: CommandRunner, preferredPath: String, bundleURL: URL?, completion: @escaping @MainActor (Outcome) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async {
            let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? "/bin/zsh"
            let shellURL = URL(fileURLWithPath: FileManager.default.isExecutableFile(atPath: shell) ? shell : "/bin/zsh")
            let pathResult = runner.runSync(executable: shellURL, arguments: ["-lc", "printf %s \"$PATH\""], timeout: 10)
            let loginPath = pathResult.succeeded ? pathResult.stdout.trimmingCharacters(in: .whitespacesAndNewlines) : nil
            let whichResult = runner.runSync(executable: shellURL, arguments: ["-lc", "command -v lexicon"], timeout: 10)
            let which = whichResult.succeeded ? whichResult.stdout.trimmingCharacters(in: .whitespacesAndNewlines) : nil

            let home = FileManager.default.homeDirectoryForCurrentUser.path
            let locator = CLILocator(home: home, loginPath: loginPath, bundleURL: bundleURL) { path in
                FileManager.default.fileExists(atPath: path)
            }
            let location = locator.resolve(preferredPath: preferredPath.isEmpty ? nil : preferredPath, loginShellResult: which)
            let outcome = Outcome(location: location, loginPath: loginPath, locator: locator)
            DispatchQueue.main.async { completion(outcome) }
        }
    }
}
