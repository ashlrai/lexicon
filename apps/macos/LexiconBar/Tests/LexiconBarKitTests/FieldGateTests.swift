import XCTest
@testable import LexiconBarKit

/// The gate that decides whether a focused field's text may be read at all.
///
/// The property these tests exist for is not "a refused field is not
/// corrected", which was always true, but "a refused field is **never read**".
/// A refusal that happens after the read leaves the user's TOTP seed or vault
/// note sitting in this process's memory, where a crash dump or an attached
/// debugger can reach it, which is precisely what the threat model in
/// SECURITY.md says does not happen.
///
/// So `RecordingField` counts the reads, and every refusal case asserts that
/// count is zero. A regression that moves the decision back behind the read
/// still corrects nothing and still logs nothing, and fails here.
final class FieldGateTests: XCTestCase {
    /// A field that answers metadata freely and records every attempt to fetch
    /// its value. The stand-in for the Accessibility seam:
    /// `FocusWatcher.Field` implements the same protocol, and its `readValue`
    /// is the one `AXUIElementCopyAttributeValue(kAXValue)` call that would
    /// pull the secret over.
    private final class RecordingField: InspectableField {
        let bundleID: String?
        let hints: SecretFieldHeuristic.FieldHints
        private let text: String

        /// How many times anything asked for this field's text.
        private(set) var reads = 0

        init(_ bundleID: String?, _ hints: SecretFieldHeuristic.FieldHints, value: String = "whatever was typed") {
            self.bundleID = bundleID
            self.hints = hints
            self.text = value
        }

        func readValue() -> String? {
            reads += 1
            return text
        }
    }

    private let defaults = AppExclusions()

    // MARK: refused, and not read

    func testAnExcludedAppsFieldIsNeverRead() {
        let field = RecordingField("com.1password.1password", .init(title: "Notes"))

        let read = FieldGate.read(field, exclusions: defaults)

        XCTAssertEqual(field.reads, 0, "an excluded app's field must not be read even once")
        XCTAssertTrue(read.refused)
        XCTAssertNil(read.value)
        XCTAssertEqual(read.refusal, "com.1password.1password is on the exclusion list")
    }

    /// The case the whole heuristic exists for: an app nobody has put on any
    /// list, holding a field whose label gives it away. TextEdit is not
    /// excluded and never will be.
    func testASecretLookingFieldInAnOrdinaryAppIsNeverRead() {
        let field = RecordingField("com.apple.TextEdit", .init(identifier: "totpSeedField"))

        let read = FieldGate.read(field, exclusions: defaults)

        XCTAssertEqual(field.reads, 0)
        XCTAssertTrue(read.refused)
        XCTAssertNil(read.value)
        // "seed" comes before "totp" in the vocabulary, and either one is the
        // right answer here; the point is that a term is named at all, so the
        // log can say why it skipped.
        XCTAssertEqual(read.refusal, "the field's labels look like a secret (seed)")
    }

    /// The window's title is metadata like any other, so the gate can see it
    /// without reading anything: an unlabelled field inside a window called
    /// "Passwords" is refused on the window alone.
    func testAWindowTitleAloneIsEnoughToRefuse() {
        let field = RecordingField("com.apple.systempreferences", .init(title: "User name", windowTitle: "Passwords"))

        let read = FieldGate.read(field, exclusions: defaults)

        XCTAssertEqual(field.reads, 0)
        XCTAssertTrue(read.refused)
    }

    /// Excluding the app the user is in right now has to stop the reads, not
    /// just the corrections: the watcher re-asks the gate on every poll, so a
    /// list that changed mid-focus refuses from that moment on and the read
    /// count stops where it was.
    func testExcludingAnAppStopsItBeingReadFromThenOn() {
        let field = RecordingField("com.obscurevault.desktop", .init(title: "Item"))
        var exclusions = AppExclusions(bundleIDs: ["com.apple.Terminal"])

        XCTAssertFalse(FieldGate.read(field, exclusions: exclusions).refused)
        XCTAssertEqual(field.reads, 1)

        exclusions.exclude("com.obscurevault.desktop")

        XCTAssertTrue(FieldGate.read(field, exclusions: exclusions).refused)
        XCTAssertEqual(field.reads, 1, "the read count must not move after the app is excluded")
    }

    func testNothingRefusedIsEverRead() {
        let cases: [(String?, SecretFieldHeuristic.FieldHints)] = [
            ("org.keepassxc.keepassxc", .init(title: "Notes")),
            ("com.bitwarden.desktop", .init(title: "Custom field")),
            ("com.apple.Terminal", .init(title: "Search")),
            ("com.apple.Safari", .init(placeholder: "Master Password")),
            ("com.apple.TextEdit", .init(title: "Recovery code")),
            ("com.apple.Notes", .init(help: "Your 2FA code")),
            (nil, .init(description: "Card number")),
        ]
        for (bundleID, hints) in cases {
            let field = RecordingField(bundleID, hints)
            XCTAssertTrue(FieldGate.read(field, exclusions: defaults).refused, "\(bundleID ?? "nil") \(hints) should be refused")
            XCTAssertEqual(field.reads, 0, "\(bundleID ?? "nil") \(hints) was read despite being refused")
        }
    }

    // MARK: admitted

    func testAnOrdinaryFieldIsReadExactlyOnce() {
        let field = RecordingField("com.apple.TextEdit", .init(title: "Message body"), value: "the quick brown fox")

        let read = FieldGate.read(field, exclusions: defaults)

        XCTAssertEqual(field.reads, 1)
        XCTAssertFalse(read.refused)
        XCTAssertNil(read.refusal)
        XCTAssertEqual(read.value, "the quick brown fox")
    }

    /// A field that cannot be read is not a field that was refused. The
    /// watcher treats the two differently: one means "the element answered no
    /// string, re-resolve focus", the other means "do not touch this".
    func testAnUnreadableFieldIsNotARefusal() {
        final class Unreadable: InspectableField {
            let bundleID: String? = "com.apple.TextEdit"
            let hints = SecretFieldHeuristic.FieldHints(title: "Document")
            func readValue() -> String? { nil }
        }

        let read = FieldGate.read(Unreadable(), exclusions: defaults)

        XCTAssertFalse(read.refused)
        XCTAssertNil(read.value)
    }

    /// An app with no bundle id cannot be matched against the list, so the
    /// labels are the only guard left. It must still be the one doing the
    /// refusing, rather than the field being admitted by default.
    func testAFieldWithNoBundleIDIsJudgedOnItsLabelsAlone() {
        let ordinary = RecordingField(nil, .init(title: "Document"))
        XCTAssertFalse(FieldGate.read(ordinary, exclusions: defaults).refused)
        XCTAssertEqual(ordinary.reads, 1)

        let secret = RecordingField(nil, .init(title: "Recovery phrase"))
        XCTAssertTrue(FieldGate.read(secret, exclusions: defaults).refused)
        XCTAssertEqual(secret.reads, 0)
    }

    // MARK: the refusal alone

    func testRefuseNamesTheTermThatMatched() {
        let refusal = FieldGate.refuse(exclusions: defaults, bundleID: "com.apple.TextEdit",
                                       hints: .init(placeholder: "Paste your API key"))
        XCTAssertEqual(refusal, "the field's labels look like a secret (api key)")
    }

    func testRefuseAdmitsOrdinaryWriting() {
        XCTAssertNil(FieldGate.refuse(exclusions: defaults, bundleID: "com.apple.TextEdit",
                                      hints: .init(title: "Document", windowTitle: "Shipping notes.txt")))
    }
}
