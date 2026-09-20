import AppKit
import ServiceManagement

// Entry point. `.accessory` keeps the app out of the Dock even when the bare
// executable is run from `swift build` (the packaged .app also sets
// LSUIElement in its Info.plist).
//
// Two launch arguments run without the UI and exit:
//   --status          prints Accessibility trust and local API reachability; exit 0 when both are fine
//   --start-at-login  registers the app as a login item (packaged .app only); exit 0 on success
@main
@MainActor
enum LexiconBarMain {
    static func main() {
        let arguments = CommandLine.arguments.dropFirst()
        if arguments.contains("--status") { exit(printStatus()) }
        if arguments.contains("--start-at-login") { exit(registerStartAtLogin()) }

        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)
        app.run()
    }

    private static func printStatus() -> Int32 {
        let trusted = AX.isTrusted
        print("Accessibility: \(trusted ? "trusted" : "not trusted (System Settings > Privacy & Security > Accessibility)")")
        let client = NormalizeClient()
        let reachable: Bool
        switch client.healthSync() {
        case .success(let terms):
            let port = client.credentials()?.port ?? 41733
            print("Local API: reachable at http://127.0.0.1:\(port) (\(terms) terms)")
            reachable = true
        case .failure(let why):
            print("Local API: \(why.description)")
            reachable = false
        }
        let token = client.credentials() != nil
        print("Token: \(token ? "found" : "missing") (\(NormalizeClient.serveJSONPath))")
        let fixOn = UserDefaults.standard.object(forKey: Settings.Keys.fixEverywhere) as? Bool ?? true
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
