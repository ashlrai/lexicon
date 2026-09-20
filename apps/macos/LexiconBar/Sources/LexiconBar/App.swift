import AppKit
import ServiceManagement
import LexiconBarKit

// Entry point. `.accessory` keeps the app out of the Dock even when the bare
// executable is run from `swift build` (the packaged .app also sets
// LSUIElement in its Info.plist).
//
// Two launch arguments run without the UI and exit:
//   --status          prints Accessibility trust and local API reachability; exit 0 when both are fine
//                     (`--status --json` prints the same facts as one JSON object)
//   --start-at-login  registers the app as a login item (packaged .app only); exit 0 on success
// One more runs the app normally and opens a window:
//   --onboard         opens the first-run setup window (also shown once on a fresh install)
@main
@MainActor
enum LexiconBarMain {
    static func main() {
        let arguments = CommandLine.arguments.dropFirst()
        if arguments.contains("--status") { exit(printStatus(json: arguments.contains("--json"))) }
        if arguments.contains("--start-at-login") { exit(registerStartAtLogin()) }

        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }

    /// `--status`, and `--status --json` for anything that wants to assert on
    /// it. Run it through the *bundle* (`LexiconBar.app/Contents/MacOS/
    /// LexiconBar --status --json`) rather than the bare `swift build` binary:
    /// Accessibility is granted per code signature, so the two have separate
    /// grants. Even then macOS attributes a permission check to the
    /// *responsible process*, which for a terminal-spawned child is the
    /// terminal, so `axTrusted` here answers "can this invocation use AX",
    /// which is not always the same answer the Finder-launched app gets.
    /// `bundlePath` and `executablePath` are reported so it is at least clear
    /// which binary answered; the running app logs its own `ax=` at launch.
    private static func printStatus(json: Bool) -> Int32 {
        let trusted = AX.isTrusted
        let client = NormalizeClient()
        let port = client.credentials()?.port ?? ServeOwnership.defaultPort
        var terms: Int?
        var apiError: String?
        switch client.healthSync() {
        case .success(let count): terms = count
        case .failure(let why): apiError = why.description
        }
        let reachable = terms != nil
        let token = client.credentials() != nil
        let fixOn = UserDefaults.standard.object(forKey: Settings.Keys.fixEverywhere) as? Bool ?? true
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        // Who runs `lexicon serve`, through the same resolver the menu uses.
        // `appChildRunning` is false here by construction: a child of the
        // running app is invisible to this separate process.
        let probe = ServeOwnershipMonitor.probeSync(runner: CommandRunner(), credentials: client)
        let serve = ServeOwnership.resolve(probe)
        let owner: String
        switch serve.ownership {
        case .launchAgent: owner = "launchAgent"
        case .appChild: owner = "appChild"
        case .foreign: owner = "foreign"
        case .none: owner = "none"
        }

        if json {
            var object: [String: Any] = [
                "axTrusted": trusted,
                "apiReachable": reachable,
                "apiPort": port,
                "tokenFound": token,
                "tokenPath": NormalizeClient.serveJSONPath,
                "fixEverywhere": fixOn,
                "bundled": Notifier.isBundled,
                "bundlePath": Bundle.main.bundlePath,
                "executablePath": Bundle.main.executablePath ?? CommandLine.arguments.first ?? "",
                "serveOwnership": owner,
                "serveTitle": serve.title,
                "serveLaunchdLoaded": probe.launchdLoaded,
                "servePlistExists": probe.plistExists,
                "serveLabel": probe.label,
            ]
            if let programPath = probe.programPath { object["serveProgramPath"] = programPath }
            if let terms { object["apiTerms"] = terms }
            if let apiError { object["apiError"] = apiError }
            if let version { object["version"] = version }
            if let identifier = Bundle.main.bundleIdentifier { object["bundleIdentifier"] = identifier }
            let data = (try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .prettyPrinted]))
                ?? Data("{\"axTrusted\":\(trusted)}".utf8)
            print(String(decoding: data, as: UTF8.self))
            return trusted && reachable && token ? 0 : 1
        }

        print("Accessibility: \(trusted ? "trusted" : "not trusted (System Settings > Privacy & Security > Accessibility)")")
        if let terms {
            print("Local API: reachable at http://127.0.0.1:\(port) (\(terms) terms)")
        } else {
            print("Local API: \(apiError ?? "not reachable")")
        }
        print("Token: \(token ? "found" : "missing") (\(NormalizeClient.serveJSONPath))")
        print("Serve ownership: \(owner) \u{2014} \(serve.title)")
        print("Fix everywhere: \(fixOn ? "on" : "off")")
        return trusted && reachable && token ? 0 : 1
    }

    private static func registerStartAtLogin() -> Int32 {
        guard Notifier.isBundled else {
            FileHandle.standardError.write(Data("--start-at-login needs the packaged LexiconBar.app (scripts/build-macos-app.sh).\n".utf8))
            return 1
        }
        do {
            try SMAppService.mainApp.register()
            print("Start at login: enabled (\(SMAppService.mainApp.status == .enabled ? "confirmed" : "pending approval in System Settings > General > Login Items"))")
            return 0
        } catch {
            FileHandle.standardError.write(Data("Start at login failed: \(error.localizedDescription)\n".utf8))
            return 1
        }
    }
}
