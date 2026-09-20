import Foundation
import Combine
import LexiconBarKit

/// User preferences, backed by UserDefaults. Observable so the SwiftUI
/// Preferences window and the AppKit menu both follow changes.
@MainActor
final class Settings: ObservableObject {
    enum Keys {
        static let cliPath = "cliPath"
        static let model = "model"
        static let pasteMode = "pasteMode"
        static let pushToTalkHotKey = "hotkey.pushToTalk"
        static let fixClipboardHotKey = "hotkey.fixClipboard"
        static let watchClipboard = "watchClipboard"
        static let localAPI = "localAPI"
        static let accessibilityHintShown = "hint.accessibilityShown"
        static let notificationsAsked = "notifications.asked"
        static let fixEverywhere = "fixEverywhere"
        static let fixSettleMs = "fixEverywhere.settleMs"
        static let fixMinWords = "fixEverywhere.minWords"
        static let fixExcludedApps = "fixEverywhere.excludedApps"
        static let fixNotify = "fixEverywhere.notify"
        static let undoFixHotKey = "hotkey.undoFix"
    }

    static let settleRange: ClosedRange<Double> = 300...1500
    static let minWordsRange: ClosedRange<Int> = 1...5

    static let models = ["base.en", "small.en"]

    private let defaults: UserDefaults

    /// Empty string means auto-detect.
    @Published var cliPath: String { didSet { defaults.set(cliPath, forKey: Keys.cliPath) } }
    @Published var model: String { didSet { defaults.set(model, forKey: Keys.model) } }
    /// true: `--paste` into the frontmost app; false: leave the text on the clipboard.
    @Published var pasteMode: Bool { didSet { defaults.set(pasteMode, forKey: Keys.pasteMode) } }
    @Published var pushToTalkHotKey: HotKey { didSet { defaults.set(pushToTalkHotKey.storage, forKey: Keys.pushToTalkHotKey) } }
    @Published var fixClipboardHotKey: HotKey { didSet { defaults.set(fixClipboardHotKey.storage, forKey: Keys.fixClipboardHotKey) } }
    @Published var watchClipboard: Bool { didSet { defaults.set(watchClipboard, forKey: Keys.watchClipboard) } }
    @Published var localAPI: Bool { didSet { defaults.set(localAPI, forKey: Keys.localAPI) } }

    // Fix everywhere (see FixEverywhere/). One exclusion list serves both the
    // Preferences editor and the "Fix everywhere in <app>" menu toggle.
    @Published var fixEverywhere: Bool { didSet { defaults.set(fixEverywhere, forKey: Keys.fixEverywhere) } }
    @Published var fixSettleMs: Double { didSet { defaults.set(fixSettleMs, forKey: Keys.fixSettleMs) } }
    @Published var fixMinWords: Int { didSet { defaults.set(fixMinWords, forKey: Keys.fixMinWords) } }
    @Published var fixExcludedApps: [String] { didSet { defaults.set(fixExcludedApps, forKey: Keys.fixExcludedApps) } }
    @Published var fixNotify: Bool { didSet { defaults.set(fixNotify, forKey: Keys.fixNotify) } }
    @Published var undoFixHotKey: HotKey { didSet { defaults.set(undoFixHotKey.storage, forKey: Keys.undoFixHotKey) } }

    var exclusions: AppExclusions {
        get { AppExclusions(bundleIDs: fixExcludedApps) }
        set { fixExcludedApps = newValue.bundleIDs }
    }

    var accessibilityHintShown: Bool {
        get { defaults.bool(forKey: Keys.accessibilityHintShown) }
        set { defaults.set(newValue, forKey: Keys.accessibilityHintShown) }
    }

    var notificationsAsked: Bool {
        get { defaults.bool(forKey: Keys.notificationsAsked) }
        set { defaults.set(newValue, forKey: Keys.notificationsAsked) }
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        cliPath = defaults.string(forKey: Keys.cliPath) ?? ""
        let storedModel = defaults.string(forKey: Keys.model) ?? Settings.models[0]
        model = Settings.models.contains(storedModel) ? storedModel : Settings.models[0]
        pasteMode = defaults.object(forKey: Keys.pasteMode) as? Bool ?? true
        pushToTalkHotKey = HotKey(storage: defaults.dictionary(forKey: Keys.pushToTalkHotKey)) ?? .defaultPushToTalk
        fixClipboardHotKey = HotKey(storage: defaults.dictionary(forKey: Keys.fixClipboardHotKey)) ?? .defaultFixClipboard
        watchClipboard = defaults.bool(forKey: Keys.watchClipboard)
        localAPI = defaults.bool(forKey: Keys.localAPI)
        fixEverywhere = defaults.object(forKey: Keys.fixEverywhere) as? Bool ?? true
        let settle = defaults.object(forKey: Keys.fixSettleMs) as? Double ?? 700
        fixSettleMs = min(max(settle, Settings.settleRange.lowerBound), Settings.settleRange.upperBound)
        let words = defaults.object(forKey: Keys.fixMinWords) as? Int ?? 3
        fixMinWords = min(max(words, Settings.minWordsRange.lowerBound), Settings.minWordsRange.upperBound)
        fixExcludedApps = defaults.stringArray(forKey: Keys.fixExcludedApps) ?? AppExclusions.defaults
        fixNotify = defaults.object(forKey: Keys.fixNotify) as? Bool ?? true
        undoFixHotKey = HotKey(storage: defaults.dictionary(forKey: Keys.undoFixHotKey)) ?? .defaultUndoFix
    }
}
