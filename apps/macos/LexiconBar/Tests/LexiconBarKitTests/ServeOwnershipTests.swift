import XCTest
@testable import LexiconBarKit

final class ServeOwnershipTests: XCTestCase {
    private func resolve(launchd: Bool, plist: Bool, api: Bool, child: Bool) -> ServeStatus {
        ServeOwnership.resolve(ServeProbe(launchdLoaded: launchd, plistExists: plist,
                                          apiReachable: api, appChildRunning: child,
                                          programPath: "/repo/dist/cli/index.js"))
    }

    // MARK: the full truth table

    /// All sixteen combinations of the four facts, with the case each must
    /// produce. launchd wins outright; then this app's own child; then a
    /// foreign listener; then nothing.
    func testTruthTable() {
        let expected: [(launchd: Bool, plist: Bool, api: Bool, child: Bool, ownership: ServeOwnership)] = [
            (false, false, false, false, .none),
            (false, false, false, true, .appChild),
            (false, false, true, false, .foreign),
            (false, false, true, true, .appChild),
            (false, true, false, false, .none),
            (false, true, false, true, .appChild),
            (false, true, true, false, .foreign),
            (false, true, true, true, .appChild),
            (true, false, false, false, .launchAgent(label: ServeOwnership.defaultLabel, programPath: "/repo/dist/cli/index.js")),
            (true, false, false, true, .launchAgent(label: ServeOwnership.defaultLabel, programPath: "/repo/dist/cli/index.js")),
            (true, false, true, false, .launchAgent(label: ServeOwnership.defaultLabel, programPath: "/repo/dist/cli/index.js")),
            (true, false, true, true, .launchAgent(label: ServeOwnership.defaultLabel, programPath: "/repo/dist/cli/index.js")),
            (true, true, false, false, .launchAgent(label: ServeOwnership.defaultLabel, programPath: "/repo/dist/cli/index.js")),
            (true, true, false, true, .launchAgent(label: ServeOwnership.defaultLabel, programPath: "/repo/dist/cli/index.js")),
            (true, true, true, false, .launchAgent(label: ServeOwnership.defaultLabel, programPath: "/repo/dist/cli/index.js")),
            (true, true, true, true, .launchAgent(label: ServeOwnership.defaultLabel, programPath: "/repo/dist/cli/index.js")),
        ]
        XCTAssertEqual(expected.count, 16, "four booleans, sixteen rows")
        for row in expected {
            let status = resolve(launchd: row.launchd, plist: row.plist, api: row.api, child: row.child)
            XCTAssertEqual(status.ownership, row.ownership,
                           "launchd=\(row.launchd) plist=\(row.plist) api=\(row.api) child=\(row.child)")
        }
    }

    /// A loaded LaunchAgent and a foreign listener both mean "hands off"; our
    /// own child and an idle port do not.
    func testOnlyLaunchAgentAndForeignBlockTheAppFromStarting() {
        XCTAssertTrue(resolve(launchd: true, plist: true, api: true, child: false).ownership.isOwnedByOther)
        XCTAssertTrue(resolve(launchd: false, plist: false, api: true, child: false).ownership.isOwnedByOther)
        XCTAssertFalse(resolve(launchd: false, plist: false, api: true, child: true).ownership.isOwnedByOther)
        XCTAssertFalse(resolve(launchd: false, plist: false, api: false, child: false).ownership.isOwnedByOther)
    }

    /// The checkbox exists only where clicking it can do something sane.
    func testInteractivityAndOnState() {
        let launchAgent = resolve(launchd: true, plist: true, api: true, child: false)
        XCTAssertFalse(launchAgent.isInteractive, "no checkbox: a click could only start a duplicate")
        XCTAssertTrue(launchAgent.isOn)

        let loadedButSilent = resolve(launchd: true, plist: true, api: false, child: false)
        XCTAssertFalse(loadedButSilent.isInteractive)
        XCTAssertFalse(loadedButSilent.isOn, "loaded is not the same as answering")

        let child = resolve(launchd: false, plist: false, api: true, child: true)
        XCTAssertTrue(child.isInteractive)
        XCTAssertTrue(child.isOn)

        let foreign = resolve(launchd: false, plist: false, api: true, child: false)
        XCTAssertFalse(foreign.isInteractive)
        XCTAssertFalse(foreign.isOn, "it is reachable, but not ours to switch off")

        let nobody = resolve(launchd: false, plist: false, api: false, child: false)
        XCTAssertTrue(nobody.isInteractive)
        XCTAssertFalse(nobody.isOn)
    }

    // MARK: the strings

    func testLaunchAgentRunningStrings() {
        let status = resolve(launchd: true, plist: true, api: true, child: false)
        XCTAssertEqual(status.title, "Local API: running at login (launchd)")
        XCTAssertEqual(status.hint, "Manage with `lexicon serve --uninstall`")
        XCTAssertEqual(status.detail,
                       "`ai.ashlr.lexicon.serve` running /repo/dist/cli/index.js owns 127.0.0.1:41733. This app will not start a second one.")
    }

    /// The program path is what tells the user *which* checkout is serving;
    /// without it the sentence still has to read properly.
    func testLaunchAgentWithoutAProgramPath() {
        let status = ServeOwnership.resolve(ServeProbe(launchdLoaded: true, apiReachable: true))
        XCTAssertEqual(status.detail,
                       "`ai.ashlr.lexicon.serve` owns 127.0.0.1:41733. This app will not start a second one.")
        XCTAssertEqual(status.ownership, .launchAgent(label: ServeOwnership.defaultLabel, programPath: nil))
    }

    func testLaunchAgentLoadedButSilentStrings() {
        let status = resolve(launchd: true, plist: true, api: false, child: false)
        XCTAssertEqual(status.title, "Local API: installed at login (launchd), not answering")
        XCTAssertTrue(status.detail.contains("Check `lexicon serve --status`."), status.detail)
        XCTAssertEqual(status.hint, "Manage with `lexicon serve --uninstall`")
    }

    func testAppChildStrings() {
        let status = resolve(launchd: false, plist: false, api: true, child: true)
        XCTAssertEqual(status.title, "Local API: running (started by this app)")
        XCTAssertEqual(status.detail,
                       "This app supervises `lexicon serve` on 127.0.0.1:41733 and stops it when you quit.")
        XCTAssertEqual(status.hint,
                       "Install it at login with `lexicon serve --install` to keep it up without the app.")
    }

    func testForeignStrings() {
        let status = resolve(launchd: false, plist: false, api: true, child: false)
        XCTAssertEqual(status.title, "Local API: reachable (not managed by this app)")
        XCTAssertTrue(status.detail.hasPrefix("Something else is already listening on 127.0.0.1:41733"), status.detail)
        XCTAssertEqual(status.hint, "Find it with `lsof -nP -iTCP:41733 -sTCP:LISTEN`")
    }

    /// Nothing running: a plain checkbox, and the hint says what ticking it does.
    func testNoneStrings() {
        let fresh = resolve(launchd: false, plist: false, api: false, child: false)
        XCTAssertEqual(fresh.title, "Run the local API")
        XCTAssertEqual(fresh.detail,
                       "`lexicon serve` on 127.0.0.1:41733. Fix everywhere and the browser extension both go through it.")
        XCTAssertEqual(fresh.hint,
                       "Ticking this installs it at login (`lexicon serve --install`) so it survives app restarts.")

        let stalePlist = resolve(launchd: false, plist: true, api: false, child: false)
        XCTAssertEqual(stalePlist.title, "Run the local API")
        XCTAssertEqual(stalePlist.hint,
                       "`ai.ashlr.lexicon.serve` is installed but not loaded; ticking this loads it again (`lexicon serve --install`).")
    }

    /// A non-default port has to reach every string, not just some of them.
    func testPortTravelsIntoEveryString() {
        for probe in [ServeProbe(launchdLoaded: true, apiReachable: true, port: 5000),
                      ServeProbe(appChildRunning: true, port: 5000),
                      ServeProbe(apiReachable: true, port: 5000),
                      ServeProbe(port: 5000)] {
            let status = ServeOwnership.resolve(probe)
            XCTAssertTrue(status.detail.contains("5000"), "\(status.ownership): \(status.detail)")
        }
    }

    /// The label is configurable through `$LEXICON_SERVE_LABEL`, so it must not
    /// be hard-coded into the sentences.
    func testCustomLabelTravels() {
        let status = ServeOwnership.resolve(ServeProbe(launchdLoaded: true, apiReachable: true, label: "test.lexicon.serve"))
        XCTAssertEqual(status.ownership, .launchAgent(label: "test.lexicon.serve", programPath: nil))
        XCTAssertTrue(status.detail.contains("`test.lexicon.serve`"), status.detail)
    }

    // MARK: plist parsing

    func testProgramPathFromPlist() throws {
        let plist = """
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
          <key>Label</key>
          <string>ai.ashlr.lexicon.serve</string>
          <key>ProgramArguments</key>
          <array>
            <string>/Users/me/.hermes/node/bin/node</string>
            <string>/Users/me/Desktop/dictation mcp/dist/cli/index.js</string>
            <string>serve</string>
          </array>
        </dict>
        </plist>
        """
        XCTAssertEqual(ServeOwnership.programPath(fromPlist: Data(plist.utf8)),
                       "/Users/me/Desktop/dictation mcp/dist/cli/index.js")
    }

    func testProgramPathFromUnusablePlists() {
        XCTAssertNil(ServeOwnership.programPath(fromPlist: Data("not a plist".utf8)))
        let noArguments = """
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict><key>Label</key><string>x</string></dict></plist>
        """
        XCTAssertNil(ServeOwnership.programPath(fromPlist: Data(noArguments.utf8)))
        let oneArgument = """
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict><key>ProgramArguments</key><array><string>/bin/node</string></array></dict></plist>
        """
        XCTAssertNil(ServeOwnership.programPath(fromPlist: Data(oneArgument.utf8)), "the script is the second entry")
    }

    func testPlistPath() {
        XCTAssertEqual(ServeOwnership.launchAgentPlistPath(home: "/Users/me"),
                       "/Users/me/Library/LaunchAgents/ai.ashlr.lexicon.serve.plist")
    }
}
