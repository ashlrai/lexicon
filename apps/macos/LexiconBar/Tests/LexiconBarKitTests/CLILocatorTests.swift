import XCTest
@testable import LexiconBarKit

final class CLILocatorTests: XCTestCase {
    private func locator(existing: Set<String>, loginPath: String? = nil, bundle: String? = nil) -> CLILocator {
        CLILocator(home: "/Users/me", loginPath: loginPath, bundleURL: bundle.map { URL(fileURLWithPath: $0) }) { existing.contains($0) }
    }

    func testPreferredPathWins() {
        let l = locator(existing: ["/custom/lexicon", "/opt/homebrew/bin/lexicon"])
        XCTAssertEqual(l.resolve(preferredPath: "/custom/lexicon", loginShellResult: "/opt/homebrew/bin/lexicon"),
                       .executable(URL(fileURLWithPath: "/custom/lexicon")))
    }

    func testMissingPreferredPathIsNotFound() {
        let l = locator(existing: ["/opt/homebrew/bin/lexicon"])
        XCTAssertNil(l.resolve(preferredPath: "/nope/lexicon", loginShellResult: nil), "an explicit but wrong path must not silently fall back")
    }

    func testLoginShellResultThenFallbacks() {
        let l = locator(existing: ["/Users/me/.local/bin/lexicon", "/usr/local/bin/lexicon"])
        XCTAssertEqual(l.resolve(preferredPath: nil, loginShellResult: "/Users/me/.local/bin/lexicon\n"),
                       .executable(URL(fileURLWithPath: "/Users/me/.local/bin/lexicon")))
        XCTAssertEqual(l.resolve(preferredPath: "", loginShellResult: "lexicon not found"),
                       .executable(URL(fileURLWithPath: "/usr/local/bin/lexicon")))
    }

    func testSourceCheckoutFallbackUsesNode() {
        let bundle = "/repo/apps/macos/build/LexiconBar.app"
        let l = locator(existing: ["/repo/dist/cli/index.js", "/opt/homebrew/bin/node"], bundle: bundle)
        XCTAssertEqual(l.resolve(preferredPath: nil, loginShellResult: nil),
                       .nodeScript(node: URL(fileURLWithPath: "/opt/homebrew/bin/node"), script: URL(fileURLWithPath: "/repo/dist/cli/index.js")))
        let noNode = locator(existing: ["/repo/dist/cli/index.js"], bundle: bundle)
        XCTAssertNil(noNode.resolve(preferredPath: nil, loginShellResult: nil))
    }

    func testUserPickedScriptRunsViaNodeFromLoginPath() {
        let l = locator(existing: ["/x/dist/cli/index.js", "/Users/me/.nvm/current/bin/node"], loginPath: "/Users/me/.nvm/current/bin:/usr/bin")
        let loc = l.resolve(preferredPath: "/x/dist/cli/index.js", loginShellResult: nil)
        XCTAssertEqual(loc, .nodeScript(node: URL(fileURLWithPath: "/Users/me/.nvm/current/bin/node"), script: URL(fileURLWithPath: "/x/dist/cli/index.js")))
        XCTAssertEqual(loc?.prefixArguments, ["/x/dist/cli/index.js"])
        XCTAssertEqual(loc?.displayPath, "/x/dist/cli/index.js")
    }

    func testChildPATHDedupesAndKeepsLoginFirst() {
        let l = locator(existing: [], loginPath: "/opt/homebrew/bin:/usr/bin")
        let path = l.childPATH(current: "/usr/bin:/bin")
        let parts = path.split(separator: ":").map(String.init)
        XCTAssertEqual(parts.first, "/opt/homebrew/bin")
        XCTAssertEqual(parts.filter { $0 == "/usr/bin" }.count, 1)
        XCTAssertTrue(parts.contains("/Users/me/.local/bin"))
        XCTAssertTrue(parts.contains("/bin"))
    }
}
