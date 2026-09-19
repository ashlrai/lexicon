import XCTest
@testable import LexiconBarKit

final class RestartPolicyTests: XCTestCase {
    func testFiveRestartsThenGiveUp() {
        var policy = RestartPolicy(backoff: 5, maxRestarts: 5, stableAfter: 60)
        for i in 1...5 {
            XCTAssertEqual(policy.delayBeforeRestart(afterUptime: 0.2), 5, "restart \(i) should be allowed")
        }
        XCTAssertTrue(policy.isExhausted)
        XCTAssertNil(policy.delayBeforeRestart(afterUptime: 0.2))
    }

    func testStableUptimeResetsBudget() {
        var policy = RestartPolicy(backoff: 5, maxRestarts: 5, stableAfter: 60)
        for _ in 1...4 { _ = policy.delayBeforeRestart(afterUptime: 1) }
        XCTAssertEqual(policy.restarts, 4)
        XCTAssertEqual(policy.delayBeforeRestart(afterUptime: 3600), 5)
        XCTAssertEqual(policy.restarts, 1, "a healthy run resets the counter before counting this restart")
    }

    func testResetOnUserAction() {
        var policy = RestartPolicy()
        for _ in 1...5 { _ = policy.delayBeforeRestart(afterUptime: 0) }
        XCTAssertTrue(policy.isExhausted)
        policy.reset()
        XCTAssertFalse(policy.isExhausted)
        XCTAssertEqual(policy.delayBeforeRestart(afterUptime: 0), 5)
    }

    func testDefaults() {
        let policy = RestartPolicy()
        XCTAssertEqual(policy.backoff, 5)
        XCTAssertEqual(policy.maxRestarts, 5)
        XCTAssertEqual(policy.stableAfter, 60)
    }
}
