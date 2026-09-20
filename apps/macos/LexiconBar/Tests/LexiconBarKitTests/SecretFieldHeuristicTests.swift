import XCTest
@testable import LexiconBarKit

/// The id-independent guard: a field whose own labels say "secret" is refused
/// in any app, including password managers that are on no exclusion list.
/// Every test here is about one of two failures — letting a secret through,
/// or swallowing an ordinary field the user actually wants corrected.
final class SecretFieldHeuristicTests: XCTestCase {

    // MARK: fields that must be refused

    func testRefusesPasswordByPlaceholder() {
        XCTAssertEqual(SecretFieldHeuristic.match(.init(placeholder: "Password")), "password")
    }

    func testRefusesPassphraseByTitle() {
        XCTAssertEqual(SecretFieldHeuristic.match(.init(title: "Master passphrase")), "passphrase")
    }

    func testRefusesCamelCaseAccessibilityIdentifier() {
        // Accessibility identifiers are code, not prose: apiKeyField,
        // totpSeedInput. The tokenizer has to split the humps or the whole
        // hint is one unmatchable word.
        XCTAssertEqual(SecretFieldHeuristic.match(.init(identifier: "apiKeyField")), "api key")
        XCTAssertEqual(SecretFieldHeuristic.match(.init(identifier: "totpSeedInput")), "seed")
        XCTAssertEqual(SecretFieldHeuristic.match(.init(identifier: "APIKeyTextField")), "api key")
    }

    func testRefusesSnakeCaseIdentifier() {
        XCTAssertEqual(SecretFieldHeuristic.match(.init(identifier: "recovery_code_2")), "recovery")
    }

    func testRefusesTOTPSeedBox() {
        XCTAssertEqual(SecretFieldHeuristic.match(.init(title: "TOTP")), "totp")
        XCTAssertEqual(SecretFieldHeuristic.match(.init(placeholder: "One time code")), "one time code")
        XCTAssertEqual(SecretFieldHeuristic.match(.init(title: "2FA code")), "2fa")
        XCTAssertEqual(SecretFieldHeuristic.match(.init(identifier: "totp2SeedField")), "seed")
    }

    func testRefusesByWindowTitleAlone() {
        // The field itself may be an unlabelled notes box; the window it sits
        // in is what says we are inside a vault.
        XCTAssertEqual(SecretFieldHeuristic.match(.init(title: "Notes", windowTitle: "My Vault — Bitwarden")), "vault")
    }

    func testRefusesPluralLabels() {
        XCTAssertEqual(SecretFieldHeuristic.match(.init(windowTitle: "Passwords")), "password")
        XCTAssertEqual(SecretFieldHeuristic.match(.init(title: "Secrets")), "secret")
    }

    func testRefusesPinAndCardVocabulary() {
        XCTAssertEqual(SecretFieldHeuristic.match(.init(placeholder: "PIN")), "pin")
        XCTAssertEqual(SecretFieldHeuristic.match(.init(placeholder: "CVV")), "cvv")
        XCTAssertEqual(SecretFieldHeuristic.match(.init(title: "Card number")), "card number")
    }

    func testRefusesHelpAndDescriptionHints() {
        XCTAssertEqual(SecretFieldHeuristic.match(.init(help: "Your recovery phrase")), "recovery")
        XCTAssertEqual(SecretFieldHeuristic.match(.init(description: "Private key")), "private key")
    }

    // MARK: fields that must NOT be refused
    //
    // A guard that swallows ordinary fields is its own bug: the user gets no
    // corrections and no explanation. These are the cases that made the
    // matcher word-based rather than a substring search.

    func testDoesNotRefuseOrdinaryNotesField() {
        XCTAssertNil(SecretFieldHeuristic.match(.init(placeholder: "Notes", title: "Notes",
                                                      roleDescription: "text entry area",
                                                      windowTitle: "Untitled — TextEdit")))
    }

    func testDoesNotRefuseWordsThatMerelyContainATerm() {
        // "shipping" contains "pin", "tokenizer" contains "token",
        // "seeded" contains "seed", "pinned" contains "pin".
        for hint in ["Shipping address", "Tokenizer settings", "Seeded randomly", "Pinned messages", "Spinner"] {
            XCTAssertNil(SecretFieldHeuristic.match(.init(title: hint)), "should not refuse \(hint)")
        }
    }

    func testDoesNotRefuseATypicalChatComposer() {
        XCTAssertNil(SecretFieldHeuristic.match(.init(identifier: "chat-input", placeholder: "Send a message",
                                                      roleDescription: "text entry area", windowTitle: "ChatGPT")))
    }

    func testDoesNotRefuseEmptyHints() {
        XCTAssertNil(SecretFieldHeuristic.match(.init()))
        XCTAssertNil(SecretFieldHeuristic.match(.init(title: "", windowTitle: "")))
    }

    // MARK: tokenizer

    func testWordsSplitsCamelCaseAndPunctuation() {
        XCTAssertEqual(SecretFieldHeuristic.words(in: "apiKey"), ["api", "key"])
        XCTAssertEqual(SecretFieldHeuristic.words(in: "API_KEY"), ["api", "key"])
        XCTAssertEqual(SecretFieldHeuristic.words(in: "My Vault — Bitwarden"), ["my", "vault", "bitwarden"])
        XCTAssertEqual(SecretFieldHeuristic.words(in: "2FA"), ["2", "fa"])
        XCTAssertEqual(SecretFieldHeuristic.words(in: "2fa"), ["2", "fa"])
    }

    func testWordsSingularizesOnlyLongEnoughWords() {
        XCTAssertEqual(SecretFieldHeuristic.words(in: "passwords"), ["password"])
        XCTAssertEqual(SecretFieldHeuristic.words(in: "is"), ["is"])
        XCTAssertEqual(SecretFieldHeuristic.words(in: "access"), ["access"])
    }
}

/// The bundle-id list itself. Vendor prefixes are used on purpose, so the
/// tests are about ids the vendors have actually shipped.
final class AppExclusionDefaultsTests: XCTestCase {
    private let exclusions = AppExclusions()

    func testExcludesTerminals() {
        for id in ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable",
                   "com.mitchellh.ghostty", "net.kovidgoyal.kitty", "io.alacritty"] {
            XCTAssertTrue(exclusions.isExcluded(id), "\(id) should be excluded")
        }
    }

    func testExcludesPasswordManagers() {
        for id in ["com.apple.Passwords", "com.apple.keychainaccess",
                   "com.1password.1password", "com.1password.1password-launcher", "com.agilebits.onepassword7",
                   "com.bitwarden.desktop", "com.dashlane.Dashlane", "com.dashlane.dashlanephonefinal",
                   "com.lastpass.LastPass", "com.lastpass.lastpassmacdesktop",
                   "org.keepassxc.keepassxc", "com.nordpass.osx", "com.nordsecurity.nordpass",
                   "in.sinew.Enpass-Desktop", "me.proton.pass", "me.proton.pass.macos",
                   "com.callpod.keepermac", "com.keepersecurity.Keeper",
                   "com.siber.roboform", "com.markmcguill.strongbox.mac"] {
            XCTAssertTrue(exclusions.isExcluded(id), "\(id) should be excluded")
        }
    }

    func testDoesNotExcludeOrdinaryApps() {
        for id in ["com.apple.TextEdit", "com.anthropic.claudefordesktop", "com.openai.codex",
                   "com.todesktop.230313mzl4w4u92", "com.apple.Safari", "com.tinyspeck.slackmacgap",
                   "com.apple.Notes", "com.microsoft.VSCode"] {
            XCTAssertFalse(exclusions.isExcluded(id), "\(id) should not be excluded")
        }
    }

    func testMatchingIsCaseInsensitive() {
        XCTAssertTrue(exclusions.isExcluded("COM.BITWARDEN.DESKTOP"))
        XCTAssertTrue(exclusions.isExcluded("com.apple.terminal"))
    }
}
