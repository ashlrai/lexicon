import XCTest
@testable import LexiconBar
@testable import LexiconBarKit

final class NormalizeContextTests: XCTestCase {
    func testRequestUsesOnlyPrecedingFieldTextAndBundleID() {
        let full = "😀 phantom Lucas after"
        let prefix = "😀 phantom "
        let burst = Burst(range: NSRange(location: prefix.utf16.count, length: 5), text: "Lucas", fullText: full)
        let body = NormalizeClient.requestBody(burst: burst, bundleID: "ai.ashlr.phantom")
        XCTAssertEqual(body["text"] as? String, "Lucas")
        let context = body["context"] as? [String: String]
        XCTAssertEqual(context?["recentText"], prefix)
        XCTAssertEqual(context?["bundleId"], "ai.ashlr.phantom")
    }

    func testContextIsBoundedAndEmptyContextIsOmitted() {
        let prefix = String(repeating: "a", count: 4_100)
        let burst = Burst(range: NSRange(location: prefix.utf16.count, length: 1), text: "x", fullText: prefix + "x")
        let context = NormalizeClient.requestBody(burst: burst, bundleID: nil)["context"] as? [String: String]
        XCTAssertEqual(context?["recentText"]?.count, 4_000)
        let first = Burst(range: NSRange(location: 0, length: 1), text: "x", fullText: "x")
        XCTAssertNil(NormalizeClient.requestBody(burst: first, bundleID: nil)["context"])
    }
}
