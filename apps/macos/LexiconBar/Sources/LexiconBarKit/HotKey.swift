import Foundation

/// A global keyboard shortcut in the encoding Carbon's `RegisterEventHotKey`
/// wants: a virtual key code plus a bitmask of Carbon modifier flags
/// (`cmdKey`, `shiftKey`, `optionKey`, `controlKey`). Pure value type so it can
/// be persisted to UserDefaults and unit tested without AppKit.
public struct HotKey: Equatable, Hashable, Codable, Sendable {
    /// Carbon modifier bits (from `<HIToolbox/Events.h>`).
    public static let command: UInt32 = 1 << 8  // cmdKey
    public static let shift: UInt32 = 1 << 9    // shiftKey
    public static let option: UInt32 = 1 << 11  // optionKey
    public static let control: UInt32 = 1 << 12 // controlKey
    public static let allModifiers: UInt32 = command | shift | option | control

    /// Virtual key codes we name in the UI (from `<HIToolbox/Events.h>`).
    public static let keySpace: UInt32 = 49
    public static let keyV: UInt32 = 9
    public static let keyEscape: UInt32 = 53

    public var keyCode: UInt32
    public var modifiers: UInt32

    public init(keyCode: UInt32, modifiers: UInt32) {
        self.keyCode = keyCode
        self.modifiers = modifiers & HotKey.allModifiers
    }

    /// Control+Option+Space: push to talk.
    public static let defaultPushToTalk = HotKey(keyCode: keySpace, modifiers: control | option)
    /// Control+Option+V: fix clipboard now.
    public static let defaultFixClipboard = HotKey(keyCode: keyV, modifiers: control | option)

    /// A small set of presets offered in Preferences next to the recorder.
    public static let presets: [HotKey] = [
        HotKey(keyCode: keySpace, modifiers: control | option),
        HotKey(keyCode: keySpace, modifiers: control | option | command),
        HotKey(keyCode: keySpace, modifiers: option | command),
        HotKey(keyCode: 105, modifiers: 0), // F13
    ]

    /// True when the combination is usable as a global hotkey: it needs at
    /// least one modifier unless the key is a function key (F1...F20), which
    /// is fine on its own.
    public var isValid: Bool {
        if modifiers != 0 { return true }
        return HotKey.functionKeyCodes.contains(keyCode)
    }

    /// Human readable form in Apple's modifier order, e.g. "⌃⌥Space".
    public var displayString: String {
        var s = ""
        if modifiers & HotKey.control != 0 { s += "\u{2303}" }
        if modifiers & HotKey.option != 0 { s += "\u{2325}" }
        if modifiers & HotKey.shift != 0 { s += "\u{21E7}" }
        if modifiers & HotKey.command != 0 { s += "\u{2318}" }
        s += HotKey.keyName(for: keyCode)
        return s
    }

    /// Modifier flags as Carbon expects them, from the AppKit `NSEvent`
    /// `modifierFlags` raw value. Kept AppKit-free so the conversion is testable:
    /// the bit positions are those of `NSEvent.ModifierFlags`.
    public static func modifiers(fromAppKitFlags raw: UInt) -> UInt32 {
        var m: UInt32 = 0
        if raw & (1 << 18) != 0 { m |= control } // NSEvent.ModifierFlags.control
        if raw & (1 << 19) != 0 { m |= option }  // .option
        if raw & (1 << 17) != 0 { m |= shift }   // .shift
        if raw & (1 << 20) != 0 { m |= command } // .command
        return m
    }

    // MARK: persistence

    /// Encodes as two integers so UserDefaults stays inspectable with `defaults read`.
    public var storage: [String: Int] {
        ["keyCode": Int(keyCode), "modifiers": Int(modifiers)]
    }

    public init?(storage: [String: Any]?) {
        guard let storage,
              let k = storage["keyCode"] as? Int,
              let m = storage["modifiers"] as? Int,
              k >= 0, k <= 0xFFFF, m >= 0 else { return nil }
        self.init(keyCode: UInt32(k), modifiers: UInt32(m))
    }

    // MARK: key names

    static let functionKeyCodes: Set<UInt32> = [
        122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, // F1-F12
        105, 107, 113, 106, 64, 79, 80, 90,                     // F13-F20
    ]

    private static let names: [UInt32: String] = [
        0: "A", 1: "S", 2: "D", 3: "F", 4: "H", 5: "G", 6: "Z", 7: "X", 8: "C", 9: "V",
        11: "B", 12: "Q", 13: "W", 14: "E", 15: "R", 16: "Y", 17: "T", 18: "1", 19: "2",
        20: "3", 21: "4", 22: "6", 23: "5", 24: "=", 25: "9", 26: "7", 27: "-", 28: "8",
        29: "0", 30: "]", 31: "O", 32: "U", 33: "[", 34: "I", 35: "P", 36: "Return",
        37: "L", 38: "J", 39: "'", 40: "K", 41: ";", 42: "\\", 43: ",", 44: "/", 45: "N",
        46: "M", 47: ".", 48: "Tab", 49: "Space", 50: "`", 51: "Delete", 53: "Escape",
        76: "Enter", 96: "F5", 97: "F6", 98: "F7", 99: "F3", 100: "F8", 101: "F9",
        103: "F11", 105: "F13", 106: "F16", 107: "F14", 109: "F10", 111: "F12", 113: "F15",
        118: "F4", 120: "F2", 122: "F1", 64: "F17", 79: "F18", 80: "F19", 90: "F20",
        114: "Help", 115: "Home", 116: "Page Up", 117: "Forward Delete", 119: "End",
        121: "Page Down", 123: "Left", 124: "Right", 125: "Down", 126: "Up",
    ]

    public static func keyName(for keyCode: UInt32) -> String {
        names[keyCode] ?? "Key \(keyCode)"
    }
}
