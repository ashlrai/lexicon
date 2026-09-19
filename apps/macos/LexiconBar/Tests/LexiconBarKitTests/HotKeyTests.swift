import XCTest
@testable import LexiconBarKit

final class HotKeyTests: XCTestCase {
    func testDefaultsDisplayInAppleOrder() {
        XCTAssertEqual(HotKey.defaultPushToTalk.displayString, "\u{2303}\u{2325}Space")
        XCTAssertEqual(HotKey.defaultFixClipboard.displayString, "\u{2303}\u{2325}V")
        let all = HotKey(keyCode: HotKey.keySpace, modifiers: HotKey.allModifiers)
        XCTAssertEqual(all.displayString, "\u{2303}\u{2325}\u{21E7}\u{2318}Space")
    }

    func testStorageRoundTrip() {
        let key = HotKey(keyCode: 105, modifiers: HotKey.command | HotKey.shift)
        let restored = HotKey(storage: key.storage)
        XCTAssertEqual(restored, key)
        XCTAssertNil(HotKey(storage: nil))
        XCTAssertNil(HotKey(storage: ["keyCode": -1, "modifiers": 0]))
        XCTAssertNil(HotKey(storage: ["keyCode": "x"]))
    }

    func testUnknownModifierBitsAreMasked() {
        let key = HotKey(keyCode: 0, modifiers: 0xFFFF_FFFF)
        XCTAssertEqual(key.modifiers, HotKey.allModifiers)
    }

    func testValidity() {
        XCTAssertTrue(HotKey.defaultPushToTalk.isValid)
        XCTAssertFalse(HotKey(keyCode: HotKey.keyV, modifiers: 0).isValid, "a bare letter would swallow typing")
        XCTAssertTrue(HotKey(keyCode: 105, modifiers: 0).isValid, "F13 alone is fine")
        for preset in HotKey.presets { XCTAssertTrue(preset.isValid, preset.displayString) }
    }

    func testAppKitFlagConversion() {
        // NSEvent.ModifierFlags: shift 1<<17, control 1<<18, option 1<<19, command 1<<20.
        let raw: UInt = (1 << 18) | (1 << 19)
        XCTAssertEqual(HotKey.modifiers(fromAppKitFlags: raw), HotKey.control | HotKey.option)
        XCTAssertEqual(HotKey.modifiers(fromAppKitFlags: 1 << 20), HotKey.command)
        XCTAssertEqual(HotKey.modifiers(fromAppKitFlags: 1 << 17), HotKey.shift)
        XCTAssertEqual(HotKey.modifiers(fromAppKitFlags: 1 << 16), 0, "caps lock is not a hotkey modifier")
    }

    func testCarbonBitValues() {
        XCTAssertEqual(HotKey.command, 256)
        XCTAssertEqual(HotKey.shift, 512)
        XCTAssertEqual(HotKey.option, 2048)
        XCTAssertEqual(HotKey.control, 4096)
    }

    func testKeyNames() {
        XCTAssertEqual(HotKey.keyName(for: 49), "Space")
        XCTAssertEqual(HotKey.keyName(for: 9), "V")
        XCTAssertEqual(HotKey.keyName(for: 105), "F13")
        XCTAssertEqual(HotKey.keyName(for: 999), "Key 999")
    }
}
