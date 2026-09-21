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
        static let showBubble = "bubble.show"
        static let bubbleSeconds = "bubble.seconds"
        static let didOnboard = "didOnboard"
    }

    static let settleRange: ClosedRange<Double> = 300...1500
    static let minWordsRange: ClosedRange<Int> = 1...5
    /// How long the correction bubble stays up. The window's own default is
    /// 4 s; the Preferences slider covers 2 to 10.
    static let bubbleSecondsRange: ClosedRange<Double> = 2...10

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

    // The correction bubble near the caret. With it off, `fixNotify` decides
    // whether a fix is announced as a notification instead.
    @Published var showBubble: Bool { didSet { defaults.set(showBubble, forKey: Keys.showBubble) } }
    @Published var bubbleSeconds: Double { didSet { defaults.set(bubbleSeconds, forKey: Keys.bubbleSeconds) } }

    /// False until the first-run window reaches its last step. Reset with
    /// `defaults delete ai.ashlr.lexiconbar didOnboard` to see it again.
    var didOnboard: Bool {
        get { defaults.bool(forKey: Keys.didOnboard) }
        set { defaults.set(newValue, forKey: Keys.didOnboard) }
    }

    var exclusions: AppExclusions {
        get { AppExclusions(bundleIDs: fixExcludedApps) }
        set { fixExcludedApps = newValue.bundleIDs }
    }

    /// The four knobs "Fix everywhere" runs on, as one value.
    struct FixSettings: Equatable {
        var enabled: Bool
        var settleMs: Double
        var minWords: Int
        var exclusions: AppExclusions
    }

    var fixSettings: FixSettings {
        FixSettings(enabled: fixEverywhere, settleMs: fixSettleMs, minWords: fixMinWords, exclusions: exclusions)
    }

    /// Every change to those four knobs, carrying the **new** values, starting
    /// with the current ones as soon as anything subscribes.
    ///
    /// This exists because of one detail of `@Published`: it emits from
    /// `willSet`, before the property holds the new value. A sink that
    /// discards the value it is handed and reads `settings` back therefore
    /// sees the value from *before* the change. That is exactly how excluding
    /// an app used to reach `FocusWatcher` as the list that did not contain
    /// it: the watcher compared it to the list it already had, found them
    /// equal, and kept reading the field the user had just excluded.
    ///
    /// `CombineLatest` carries the new value through instead. Whichever knob
    /// moved, its own publisher emits the value being assigned, the other
    /// three contribute their latest, and nothing is read off the object at
    /// all. Sinks get a whole `FixSettings` and have nothing left to read
    /// back.
    var fixSettingsChanges: AnyPublisher<FixSettings, Never> {
        Publishers.CombineLatest4($fixEverywhere, $fixSettleMs, $fixMinWords, $fixExcludedApps)
            .map { FixSettings(enabled: $0, settleMs: $1, minWords: $2, exclusions: AppExclusions(bundleIDs: $3)) }
            .removeDuplicates()
            .eraseToAnyPublisher()
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
        showBubble = defaults.object(forKey: Keys.showBubble) as? Bool ?? true
        let seconds = defaults.object(forKey: Keys.bubbleSeconds) as? Double ?? 4
        bubbleSeconds = min(max(seconds, Settings.bubbleSecondsRange.lowerBound), Settings.bubbleSecondsRange.upperBound)
    }
}
