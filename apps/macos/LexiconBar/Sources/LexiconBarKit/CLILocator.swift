import Foundation

/// How to launch the `lexicon` CLI: either a binary (the npm-installed
/// `lexicon` shim, which is a `#!/usr/bin/env node` script) or the repo's
/// `dist/cli/index.js` run through `node`.
public enum CLILocation: Equatable, Sendable {
    case executable(URL)
    case nodeScript(node: URL, script: URL)

    public var executableURL: URL {
        switch self {
        case .executable(let url): return url
        case .nodeScript(let node, _): return node
        }
    }

    /// Arguments that go before the lexicon subcommand.
    public var prefixArguments: [String] {
        switch self {
        case .executable: return []
        case .nodeScript(_, let script): return [script.path]
        }
    }

    public var displayPath: String {
        switch self {
        case .executable(let url): return url.path
        case .nodeScript(_, let script): return script.path
        }
    }
}

/// Finds the CLI. Order: the user's explicit preference, then what the login
/// shell resolves, then the well-known Homebrew/npm prefixes, then a
/// `dist/cli/index.js` next to a source checkout (the app bundle built by
/// `scripts/build-macos-app.sh` sits at `<repo>/apps/macos/build`).
public struct CLILocator: Sendable {
    public typealias FileExists = @Sendable (String) -> Bool

    public let home: String
    public let fileExists: FileExists
    /// The PATH the login shell reports; used to find `node` for `.js` scripts.
    public let loginPath: String?
    /// The app bundle location, for the source-checkout fallback.
    public let bundleURL: URL?

    public init(home: String, loginPath: String?, bundleURL: URL?, fileExists: @escaping FileExists) {
        self.home = home
        self.loginPath = loginPath
        self.bundleURL = bundleURL
        self.fileExists = fileExists
    }

    public static let executableFallbacks = ["/opt/homebrew/bin/lexicon", "/usr/local/bin/lexicon"]

    /// Directories where `node` tends to live when the login shell does not
    /// export them (nvm/volta/fnm/n set PATH in .zshrc, not .zprofile).
    public var nodeSearchDirectories: [String] {
        var dirs: [String] = []
        if let loginPath {
            dirs += loginPath.split(separator: ":").map(String.init)
        }
        dirs += ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.volta/bin",
                 "\(home)/.fnm/aliases/default/bin", "\(home)/.nvm/versions/node/current/bin", "/usr/bin"]
        // nvm: any installed version, newest name first.
        let nvm = "\(home)/.nvm/versions/node"
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
            dirs += versions.sorted(by: >).map { "\(nvm)/\($0)/bin" }
        }
        return dirs
    }

    public func findNode() -> URL? {
        for dir in nodeSearchDirectories {
            let candidate = dir.hasSuffix("/") ? dir + "node" : dir + "/node"
            if fileExists(candidate) { return URL(fileURLWithPath: candidate) }
        }
        return nil
    }

    /// Turns a user-chosen path into a location. `.js`/`.mjs` files run via node.
    public func location(forUserPath path: String) -> CLILocation? {
        let expanded = (path as NSString).expandingTildeInPath
        guard !expanded.isEmpty, fileExists(expanded) else { return nil }
        let url = URL(fileURLWithPath: expanded)
        if ["js", "mjs", "cjs"].contains(url.pathExtension.lowercased()) {
            guard let node = findNode() else { return nil }
            return .nodeScript(node: node, script: url)
        }
        return .executable(url)
    }

    /// `dist/cli/index.js` candidates relative to the bundle and the home dir.
    public var sourceCheckoutScripts: [String] {
        var out: [String] = []
        if let bundleURL {
            // <repo>/apps/macos/build/LexiconBar.app -> <repo>
            let repo = bundleURL.deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().deletingLastPathComponent()
            out.append(repo.appendingPathComponent("dist/cli/index.js").path)
        }
        return out
    }

    /// Resolve using an optional preference and the login-shell lookup result
    /// (`command -v lexicon`, already run by the caller).
    public func resolve(preferredPath: String?, loginShellResult: String?) -> CLILocation? {
        if let preferredPath, !preferredPath.trimmingCharacters(in: .whitespaces).isEmpty {
            return location(forUserPath: preferredPath)
        }
        if let found = loginShellResult?.trimmingCharacters(in: .whitespacesAndNewlines), found.hasPrefix("/"),
           let loc = location(forUserPath: found) {
            return loc
        }
        for candidate in CLILocator.executableFallbacks where fileExists(candidate) {
            return .executable(URL(fileURLWithPath: candidate))
        }
        for script in sourceCheckoutScripts where fileExists(script) {
            if let node = findNode() { return .nodeScript(node: node, script: URL(fileURLWithPath: script)) }
        }
        return nil
    }

    /// PATH for child processes: the login PATH plus the usual prefixes, so the
    /// `#!/usr/bin/env node` shebang resolves even when the app was launched
    /// from Finder with the minimal system PATH.
    public func childPATH(current: String?) -> String {
        var seen = Set<String>()
        var parts: [String] = []
        let login: [String] = loginPath?.split(separator: ":").map(String.init) ?? []
        let existing: [String] = current?.split(separator: ":").map(String.init) ?? []
        let system: [String] = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        let candidates: [String] = login + nodeSearchDirectories + existing + system
        for p in candidates where !p.isEmpty && seen.insert(p).inserted {
            parts.append(p)
        }
        return parts.joined(separator: ":")
    }
}
