import XCTest
@testable import LexiconBarKit

final class CLIOutputTests: XCTestCase {
    let voiceJSON = """
    {"raw":"tell ashler to deploy on cooper netties","output":"tell Ashlr.AI to deploy on Kubernetes","replacements":[{"original":"ashler","replacement":"Ashlr.AI","reason":"alias","confidence":1,"start":5,"end":11},{"original":"cooper netties","replacement":"Kubernetes","reason":"phonetic","confidence":0.85}],"summary":"Corrected 2 words","model":"base.en","seconds":3.2,"ms":812}
    """

    func testVoiceResultParses() throws {
        let result = try XCTUnwrap(VoiceResult.parse(voiceJSON))
        XCTAssertEqual(result.output, "tell Ashlr.AI to deploy on Kubernetes")
        XCTAssertEqual(result.replacements.count, 2)
        XCTAssertEqual(result.replacements[0].label, "ashler \u{2192} Ashlr.AI")
        XCTAssertEqual(result.replacements[1].reason, "phonetic")
        XCTAssertEqual(result.replacements[1].confidence, 0.85)
        XCTAssertEqual(result.summary, "Corrected 2 words")
        XCTAssertEqual(result.model, "base.en")
        XCTAssertEqual(result.seconds, 3.2)
        XCTAssertEqual(result.ms, 812)
        XCTAssertNil(result.pasted)
        XCTAssertNil(result.error)
    }

    func testVoiceResultAcceptsCanonicalKeyAndMissingSummary() throws {
        let json = #"{"raw":"x","output":"y","replacements":[{"original":"x","canonical":"y"}]}"#
        let result = try XCTUnwrap(VoiceResult.parse(json))
        XCTAssertEqual(result.replacements, [Replacement(original: "x", replacement: "y")])
        XCTAssertEqual(result.summary, "Corrected 1 word")
    }

    func testVoiceResultTolleratesLeadingNoise() throws {
        let text = "warning: model download cached\n" + voiceJSON + "\n"
        XCTAssertNotNil(VoiceResult.parse(text))
    }

    func testToggleOutcomes() {
        XCTAssertEqual(VoiceToggleOutcome.parse(stdout: "recording\n"), .recording)
        XCTAssertEqual(VoiceToggleOutcome.parse(stdout: "Recording... press again to stop\n"), .recording)
        XCTAssertEqual(VoiceToggleOutcome.parse(stdout: #"{"status":"recording"}"#), .recording)
        if case .finished(let r) = VoiceToggleOutcome.parse(stdout: voiceJSON) {
            XCTAssertEqual(r.replacements.count, 2)
        } else {
            XCTFail("expected finished")
        }
        XCTAssertEqual(VoiceToggleOutcome.parse(stdout: "whisper: model not found"), .unrecognized("whisper: model not found"))
        XCTAssertEqual(VoiceToggleOutcome.parse(stdout: ""), .unrecognized(""))
    }

    func testClipboardOnceTextParses() {
        let out = """
        2 corrections
        "Ashler" -> "Ashlr.AI" (alias, 1.00)
        "cooper netties" -> "Kubernetes" (phonetic, 0.85)

        """
        let parsed = ClipboardOnceResult.parse(stdout: out)
        XCTAssertEqual(parsed.replacements.count, 2)
        XCTAssertEqual(parsed.replacements[0], Replacement(original: "Ashler", replacement: "Ashlr.AI", reason: "alias", confidence: 1.0))
        XCTAssertEqual(parsed.replacements[1].replacement, "Kubernetes")
        XCTAssertEqual(parsed.summary, "Corrected 2 words")
        XCTAssertNil(parsed.note)
    }

    func testClipboardOnceHandlesQuotesInsideWords() {
        let out = "1 correction\n\"it's ashler\" -> \"it's Ashlr.AI\" (alias, 1.00)\n"
        let parsed = ClipboardOnceResult.parse(stdout: out)
        XCTAssertEqual(parsed.replacements, [Replacement(original: "it's ashler", replacement: "it's Ashlr.AI", reason: "alias", confidence: 1.0)])
    }

    func testClipboardOnceNoChanges() {
        let parsed = ClipboardOnceResult.parse(stdout: "no changes (clipboard is empty or not text)\n")
        XCTAssertTrue(parsed.replacements.isEmpty)
        XCTAssertEqual(parsed.note, "no changes (clipboard is empty or not text)")
        XCTAssertEqual(parsed.summary, "no changes (clipboard is empty or not text)")
        XCTAssertEqual(ClipboardOnceResult.parse(stdout: "no changes\n").summary, "no changes")
    }

    func testClipboardOncePrefersJSON() {
        let parsed = ClipboardOnceResult.parse(stdout: #"{"replacements":[{"original":"a","replacement":"b"}],"summary":"Corrected 1 word"}"#)
        XCTAssertEqual(parsed.replacements.count, 1)
        XCTAssertEqual(parsed.note, "Corrected 1 word")
    }

    func testPathsParse() {
        let paths = LexiconPaths.parse(stdout: "global: /Users/me/.config/lexicon/lexicon.yaml\nproject: (none)\n")
        XCTAssertEqual(paths.global, "/Users/me/.config/lexicon/lexicon.yaml")
        XCTAssertNil(paths.project)
        let withProject = LexiconPaths.parse(stdout: "global: /g/lexicon.yaml\nproject: /repo/.lexicon.yaml\n")
        XCTAssertEqual(withProject.project, "/repo/.lexicon.yaml")
    }

    func testStatsParse() throws {
        let json = """
        {"termCount":42,"aliasCount":120,"totalHits":317,"topTerms":[{"canonical":"Ashlr.AI","hits":200},{"canonical":"Kubernetes","hits":17}],"neverHit":["Hetzner"],"byCategory":{"company":3},"bySource":{"manual":42},"files":[{"path":"/g","scope":"global","terms":42}]}
        """
        let stats = try XCTUnwrap(StatsSummary.parse(stdout: json))
        XCTAssertEqual(stats.counts.prefix(3).map(\.label), ["Term count", "Alias count", "Total hits"])
        XCTAssertEqual(stats.counts.prefix(3).map(\.value), [42, 120, 317])
        XCTAssertTrue(stats.counts.contains(where: { $0.label == "Never hit" && $0.value == 1 }))
        XCTAssertEqual(stats.topTerms.map(\.0), ["Ashlr.AI", "Kubernetes"])
        XCTAssertTrue(stats.text.contains("Term count: 42"))
        XCTAssertTrue(stats.text.contains("Ashlr.AI (200)"))
        XCTAssertNil(StatsSummary.parse(stdout: "not json"))
    }

    func testDefaultSummary() {
        XCTAssertEqual(CLIOutput.defaultSummary(count: 0), "No changes")
        XCTAssertEqual(CLIOutput.defaultSummary(count: 1), "Corrected 1 word")
        XCTAssertEqual(CLIOutput.defaultSummary(count: 5), "Corrected 5 words")
    }

    func testPasteFailureDetection() {
        let ok = VoiceResult.parse(voiceJSON)
        XCTAssertFalse(CLIOutput.indicatesPasteFailure(result: ok, stderr: "", exitCode: 0, pasteRequested: true))
        XCTAssertFalse(CLIOutput.indicatesPasteFailure(result: nil, stderr: "--paste failed: osascript", exitCode: 1, pasteRequested: false),
                       "no paste requested, so nothing to hint about")
        XCTAssertTrue(CLIOutput.indicatesPasteFailure(result: nil,
                                                      stderr: "--paste failed: ... needs Accessibility permission: System Settings > Privacy & Security > Accessibility.",
                                                      exitCode: 1, pasteRequested: true))
        let notPasted = VoiceResult.parse(#"{"raw":"a","output":"a","replacements":[],"pasted":false}"#)
        XCTAssertTrue(CLIOutput.indicatesPasteFailure(result: notPasted, stderr: "", exitCode: 0, pasteRequested: true))
        let withError = VoiceResult.parse(#"{"raw":"a","output":"a","pasteError":"osascript is not allowed to send keystrokes"}"#)
        XCTAssertTrue(CLIOutput.indicatesPasteFailure(result: withError, stderr: "", exitCode: 0, pasteRequested: true))
    }
}
