import XCTest
@testable import LexiconBarKit

final class FixEverywhereSupportTests: XCTestCase {
    // MARK: splice math

    func testSpliceByUTF16Range() {
        let full = "ping ashler about the rollout"
        XCTAssertEqual(TextDiff.splice(full, utf16: NSRange(location: 5, length: 6), with: "Ashlr.AI"), "ping Ashlr.AI about the rollout")
        XCTAssertEqual(TextDiff.splice("abc", utf16: NSRange(location: 3, length: 0), with: "d"), "abcd")
        XCTAssertEqual(TextDiff.splice("abc", utf16: NSRange(location: 0, length: 3), with: ""), "")
        XCTAssertNil(TextDiff.splice("abc", utf16: NSRange(location: 2, length: 5), with: "x"))
        XCTAssertNil(TextDiff.splice("abc", utf16: NSRange(location: -1, length: 1), with: "x"))
        XCTAssertNil(TextDiff.substring("abc", utf16: NSRange(location: 4, length: 0)))
        let emoji = "\u{1F680} go \u{1F680}"
        XCTAssertEqual(TextDiff.splice(emoji, utf16: NSRange(location: 3, length: 2), with: "GO"), "\u{1F680} GO \u{1F680}")
    }

    // MARK: rewrite plan

    private let burst = Burst(range: NSRange(location: 4, length: 44),
                              text: "ping ashler about the cooper netties rollout",
                              fullText: "Hi. ping ashler about the cooper netties rollout")

    private func response(output: String, changed: Bool = true, replacements: [FixReplacement] = []) -> NormalizeResponse {
        NormalizeResponse(input: burst.text, output: output, changed: changed, replacements: replacements, summary: "")
    }

    func testPlanSplicesAndPlacesCaretAfterSpan() throws {
        let r = response(output: "ping Ashlr.AI about the Kubernetes rollout", replacements: [
            FixReplacement(start: 5, end: 11, original: "ashler", replacement: "Ashlr.AI"),
            FixReplacement(start: 22, end: 36, original: "cooper netties", replacement: "Kubernetes"),
        ])
        let plan = try RewritePlan.make(burst: burst, response: r, currentFieldText: burst.fullText).get()
        XCTAssertEqual(plan.splicedFullText, "Hi. ping Ashlr.AI about the Kubernetes rollout")
        XCTAssertEqual(plan.range, burst.range)
        XCTAssertEqual(plan.caret, NSRange(location: 4 + "ping Ashlr.AI about the Kubernetes rollout".utf16.count, length: 0))
        XCTAssertEqual(plan.previousText, burst.text)
    }

    func testPlanRefusals() {
        XCTAssertEqual(RewritePlan.make(burst: burst, response: response(output: burst.text, changed: false), currentFieldText: burst.fullText),
                       .failure(.unchanged))
        XCTAssertEqual(RewritePlan.make(burst: burst, response: response(output: burst.text, changed: true), currentFieldText: burst.fullText),
                       .failure(.unchanged), "changed flag without an actual difference")
        XCTAssertEqual(RewritePlan.make(burst: burst, response: response(output: "x y z"), currentFieldText: burst.fullText + "!"),
                       .failure(.fieldChanged))
        XCTAssertEqual(RewritePlan.make(burst: burst, response: response(output: "x y z"), currentFieldText: burst.fullText, maxFieldLength: 10),
                       .failure(.fieldTooLong))
        let outside = response(output: "x", replacements: [FixReplacement(start: 40, end: 50, original: "a", replacement: "b")])
        XCTAssertEqual(RewritePlan.make(burst: burst, response: outside, currentFieldText: burst.fullText), .failure(.replacementOutsideBurst))
        let multi = Burst(range: NSRange(location: 0, length: 7), text: "a b\nc d", fullText: "a b\nc d")
        XCTAssertEqual(RewritePlan.make(burst: multi, response: response(output: "A b\nc d"), currentFieldText: multi.fullText),
                       .failure(.multiParagraph))
        XCTAssertEqual(RewritePlan.make(burst: burst, response: response(output: "ping Ashlr.AI\nabout the rollout"), currentFieldText: burst.fullText),
                       .failure(.multiParagraph), "an output newline would be typed as Return")
        let stale = Burst(range: NSRange(location: 40, length: 20), text: "nope", fullText: "short")
        XCTAssertEqual(RewritePlan.make(burst: stale, response: response(output: "x"), currentFieldText: "short"), .failure(.rangeOutOfBounds))
    }

    func testNormalizeResponseParses() throws {
        let json = #"{"input":"ping ashler","output":"ping Ashlr.AI","replacements":[{"start":5,"end":11,"original":"ashler","replacement":"Ashlr.AI","canonical":"Ashlr.AI","reason":"alias","confidence":1}],"changed":true,"summary":"1 correction"}"#
        let r = try XCTUnwrap(NormalizeResponse.parse(Data(json.utf8)))
        XCTAssertTrue(r.changed)
        XCTAssertEqual(r.output, "ping Ashlr.AI")
        XCTAssertEqual(r.replacements, [FixReplacement(start: 5, end: 11, original: "ashler", replacement: "Ashlr.AI", reason: "alias", confidence: 1)])
        XCTAssertEqual(r.replacements[0].asReplacement.label, "ashler \u{2192} Ashlr.AI")
        XCTAssertEqual(r.summary, "1 correction")
        XCTAssertNil(NormalizeResponse.parse(Data("{\"error\":\"nope\"}".utf8)))
        XCTAssertNil(NormalizeResponse.parse(Data("not json".utf8)))
        let minimal = try XCTUnwrap(NormalizeResponse.parse(Data(#"{"input":"a","output":"b"}"#.utf8)))
        XCTAssertTrue(minimal.changed)
        XCTAssertEqual(minimal.summary, "No changes")
    }

    // MARK: exclusions

    func testExclusionMatching() {
        var ex = AppExclusions()
        XCTAssertTrue(ex.isExcluded("com.apple.Terminal"))
        XCTAssertTrue(ex.isExcluded("COM.APPLE.terminal"), "case-insensitive")
        XCTAssertTrue(ex.isExcluded("com.1password.1password"))
        XCTAssertFalse(ex.isExcluded("com.apple.TextEdit"))
        XCTAssertFalse(ex.isExcluded(nil))
        XCTAssertFalse(ex.isExcluded(""))

        ex.exclude("com.apple.TextEdit")
        XCTAssertTrue(ex.isExcluded("com.apple.TextEdit"))
        ex.exclude(" com.apple.TextEdit ")
        XCTAssertEqual(ex.bundleIDs.filter { $0 == "com.apple.TextEdit" }.count, 1, "no duplicates")
        ex.include("com.apple.textedit")
        XCTAssertFalse(ex.isExcluded("com.apple.TextEdit"))

        ex.bundleIDs.append("com.jetbrains.*")
        XCTAssertTrue(ex.isExcluded("com.jetbrains.intellij"))
        XCTAssertFalse(ex.isExcluded("com.jetbrainsX"))

        ex.include("com.apple.Terminal")
        XCTAssertFalse(ex.isExcluded("com.apple.Terminal"), "defaults can be removed")
    }

    /// Taking one app back out of the list must not widen a vendor rule.
    ///
    /// `include` used to remove every entry that matched, wildcards included,
    /// so "Fix everywhere in 1Password" deleted `com.1password.*` and admitted
    /// every other 1Password process with it, on the strength of one click
    /// about one of them. Now the exact entry is all that goes, and the caller
    /// is handed the rule that still covers the app so the menu can say why
    /// nothing changed.
    func testIncludingOneAppLeavesTheVendorRuleStanding() {
        var ex = AppExclusions()
        XCTAssertEqual(ex.matchingEntry("com.1password.1password"), "com.1password.*")

        let stillExcludedBy = ex.include("com.1password.1password")

        XCTAssertEqual(stillExcludedBy, "com.1password.*")
        XCTAssertTrue(ex.bundleIDs.contains("com.1password.*"), "the vendor rule stays")
        XCTAssertTrue(ex.isExcluded("com.1password.1password7"), "and still covers the vendor")
    }

    func testIncludingAnAppOnlyTheExactEntryCoversAdmitsIt() {
        var ex = AppExclusions(bundleIDs: ["com.apple.Terminal", "com.obscurevault.desktop"])

        XCTAssertNil(ex.include("com.obscurevault.desktop"))
        XCTAssertFalse(ex.isExcluded("com.obscurevault.desktop"))
        XCTAssertEqual(ex.bundleIDs, ["com.apple.Terminal"])
    }

    /// The menu's per-app switch, both ways round.
    func testToggleAddsThenRemovesTheExactEntry() {
        var ex = AppExclusions(bundleIDs: ["com.apple.Terminal"])

        XCTAssertEqual(ex.toggle("com.apple.TextEdit"), "com.apple.TextEdit")
        XCTAssertTrue(ex.isExcluded("com.apple.TextEdit"))

        XCTAssertNil(ex.toggle("com.apple.TextEdit"))
        XCTAssertFalse(ex.isExcluded("com.apple.TextEdit"))
        XCTAssertEqual(ex.bundleIDs, ["com.apple.Terminal"])

        // Excluding answers with the entry that now does the excluding, which
        // is the id itself.
        XCTAssertEqual(ex.toggle("com.1password.1password"), "com.1password.1password")

        // Un-excluding one covered by a vendor rule answers with that rule:
        // nothing changed, and the caller has the reason to show.
        var vendor = AppExclusions()
        XCTAssertEqual(vendor.toggle("com.1password.1password"), "com.1password.*")
        XCTAssertTrue(vendor.isExcluded("com.1password.1password"))
    }

    // MARK: undo

    func testUndoBookkeeping() {
        var ledger = UndoLedger()
        XCTAssertFalse(ledger.canUndo(fieldKey: "a", currentText: "x"))
        let entry = UndoLedger.Entry(fieldKey: "textedit:123",
                                     range: NSRange(location: 4, length: 44),
                                     correctedText: "ping Ashlr.AI about the Kubernetes rollout",
                                     previousText: "ping ashler about the cooper netties rollout",
                                     fieldTextAfter: "Hi. ping Ashlr.AI about the Kubernetes rollout")
        ledger.record(entry)
        XCTAssertEqual(entry.fieldTextBefore, "Hi. ping ashler about the cooper netties rollout")
        XCTAssertFalse(ledger.canUndo(fieldKey: "other:1", currentText: entry.fieldTextAfter), "different field")
        XCTAssertFalse(ledger.canUndo(fieldKey: entry.fieldKey, currentText: entry.fieldTextAfter + " more"), "user kept typing")
        XCTAssertTrue(ledger.canUndo(fieldKey: entry.fieldKey, currentText: entry.fieldTextAfter))
        XCTAssertNil(ledger.take(fieldKey: entry.fieldKey, currentText: "changed"))
        XCTAssertEqual(ledger.last, entry, "a refused take keeps the entry")
        XCTAssertEqual(ledger.take(fieldKey: entry.fieldKey, currentText: entry.fieldTextAfter), entry)
        XCTAssertNil(ledger.last, "consumed")
        ledger.record(entry)
        ledger.clear()
        XCTAssertNil(ledger.last)
    }
}
