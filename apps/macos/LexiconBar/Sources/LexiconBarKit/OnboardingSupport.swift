import Foundation

/// The pure half of the first-run window: which step is showing, which ones
/// are done, and the draft terms the user is building on step 2. The SwiftUI
/// views and the network calls live in `LexiconBar/Onboarding/`.

public enum OnboardingStep: Int, CaseIterable, Equatable, Sendable, Comparable {
    /// What this does, plus Accessibility and local-API status.
    case welcome
    /// The names dictation gets wrong, with suggested aliases.
    case words
    /// developer / ai / business / voice-tools.
    case packs
    /// Fix everywhere, clipboard watcher, login service, hotkeys.
    case whereItWorks
    /// Summary; writes `didOnboard`.
    case done

    public static func < (a: OnboardingStep, b: OnboardingStep) -> Bool { a.rawValue < b.rawValue }

    public var title: String {
        switch self {
        case .welcome: return "Welcome"
        case .words: return "Your words"
        case .packs: return "Starter packs"
        case .whereItWorks: return "Where it works"
        case .done: return "Done"
        }
    }

    /// SF Symbol for the step header.
    public var symbol: String {
        switch self {
        case .welcome: return "hand.wave"
        case .words: return "textformat.abc"
        case .packs: return "shippingbox"
        case .whereItWorks: return "checklist"
        case .done: return "checkmark.seal"
        }
    }
}

/// Linear walk through `OnboardingStep` with a record of what got done.
///
/// `next` completes the current step and moves on; `skip` moves on without
/// completing it; `back` never un-completes anything, so walking backwards to
/// re-read a finished step and forwards again is free.
public struct OnboardingFlow: Equatable, Sendable {
    public private(set) var step: OnboardingStep
    /// Steps the user actually finished (a skipped step is not in here).
    public private(set) var completed: Set<OnboardingStep>

    public init(step: OnboardingStep = .welcome, completed: Set<OnboardingStep> = []) {
        self.step = step
        self.completed = completed
    }

    public var isFirst: Bool { step == OnboardingStep.allCases.first }
    public var isLast: Bool { step == OnboardingStep.allCases.last }

    public func isComplete(_ step: OnboardingStep) -> Bool { completed.contains(step) }

    /// One bool per step, for the progress dots row.
    public var dots: [Bool] { OnboardingStep.allCases.map { $0 <= step } }

    /// Finishes the current step and advances. No-op on the last step.
    public mutating func next() {
        completed.insert(step)
        advance()
    }

    /// Advances without marking the current step complete.
    public mutating func skip() {
        advance()
    }

    /// The "Skip setup" escape hatch: straight to the summary, completing nothing new.
    public mutating func skipToEnd() {
        step = OnboardingStep.allCases.last ?? step
    }

    public mutating func back() {
        guard let index = OnboardingStep.allCases.firstIndex(of: step), index > 0 else { return }
        step = OnboardingStep.allCases[index - 1]
    }

    /// Jump straight to a step, e.g. from a progress dot. Does not complete anything.
    public mutating func go(to target: OnboardingStep) {
        step = target
    }

    private mutating func advance() {
        guard let index = OnboardingStep.allCases.firstIndex(of: step),
              index + 1 < OnboardingStep.allCases.count else { return }
        step = OnboardingStep.allCases[index + 1]
    }
}

/// One suggested (or hand-typed) spelling of what dictation writes, with
/// whether it will be sent to `POST /add`.
public struct AliasChip: Equatable, Sendable, Identifiable {
    public let text: String
    public var isOn: Bool
    /// True when the user typed it rather than `GET /aliases` suggesting it.
    public let isCustom: Bool

    public var id: String { text.lowercased() }

    public init(text: String, isOn: Bool = true, isCustom: Bool = false) {
        self.text = text
        self.isOn = isOn
        self.isCustom = isCustom
    }
}

/// A row of the "Your words" table: one canonical spelling plus its chips.
public struct TermDraft: Equatable, Sendable, Identifiable {
    public let id: UUID
    public var canonical: String
    public private(set) var chips: [AliasChip]
    /// True while `GET /aliases` is in flight, so the view can hold the row's
    /// height steady and show a spinner instead of jumping.
    public var isLoadingSuggestions: Bool
    /// The canonical the chips were fetched for; a refetch is pointless when unchanged.
    public private(set) var suggestionsFor: String?
    /// True once `POST /add` succeeded for this row.
    public var submitted: Bool

    public init(id: UUID = UUID(), canonical: String = "", chips: [AliasChip] = [],
                isLoadingSuggestions: Bool = false, suggestionsFor: String? = nil, submitted: Bool = false) {
        self.id = id
        self.canonical = canonical
        self.chips = chips
        self.isLoadingSuggestions = isLoadingSuggestions
        self.suggestionsFor = suggestionsFor
        self.submitted = submitted
    }

    public var trimmedCanonical: String { canonical.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Enough to post: a canonical. Aliases may be empty — the API fills in
    /// its own suggestions when the list is omitted.
    public var isReady: Bool { !trimmedCanonical.isEmpty }

    /// The chips that will be sent, in display order.
    public var selectedAliases: [String] { chips.filter(\.isOn).map(\.text) }

    /// True when the canonical has changed since the last fetch, so the view
    /// should ask `GET /aliases` again.
    public var needsSuggestions: Bool {
        guard isReady else { return false }
        return suggestionsFor?.caseInsensitiveCompare(trimmedCanonical) != .orderedSame
    }

    /// Folds a `GET /aliases` answer in. Chips already on the row keep their
    /// on/off state (the user's toggle wins over a refetch) and custom chips
    /// are always kept; genuinely new suggestions arrive switched on. An
    /// alias equal to the canonical is dropped — the matcher has it already.
    public mutating func applySuggestions(_ aliases: [String], for canonical: String) {
        suggestionsFor = canonical
        isLoadingSuggestions = false
        let canonicalKey = canonical.lowercased()
        var seen = Set(chips.map(\.id))
        for alias in aliases {
            let text = alias.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            let key = text.lowercased()
            guard key != canonicalKey, !seen.contains(key) else { continue }
            seen.insert(key)
            chips.append(AliasChip(text: text, isOn: true, isCustom: false))
        }
    }

    /// Flips one chip. Unknown ids are ignored.
    public mutating func toggle(_ id: String) {
        guard let index = chips.firstIndex(where: { $0.id == id }) else { return }
        chips[index].isOn.toggle()
    }

    /// Adds a hand-typed spelling. Returns false when it is blank, equal to
    /// the canonical, or already present (in which case an existing chip that
    /// was switched off is switched back on, which is what the user meant).
    @discardableResult
    public mutating func addCustom(_ alias: String) -> Bool {
        let text = alias.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.lowercased() != trimmedCanonical.lowercased() else { return false }
        if let index = chips.firstIndex(where: { $0.id == text.lowercased() }) {
            chips[index].isOn = true
            return false
        }
        chips.append(AliasChip(text: text, isOn: true, isCustom: true))
        return true
    }

    public mutating func removeChip(_ id: String) {
        chips.removeAll { $0.id == id }
    }

    /// Wipes the chips when the canonical changes, so the old term's
    /// suggestions never get posted under the new name.
    public mutating func canonicalChanged(to newValue: String) {
        guard newValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                != trimmedCanonical.lowercased() else {
            canonical = newValue
            return
        }
        canonical = newValue
        chips.removeAll { !$0.isCustom }
        suggestionsFor = nil
    }
}

/// Which starter packs are on. Separate from the network so the toggle can be
/// optimistic and roll back on failure.
public struct PackSelection: Equatable, Sendable {
    /// Installed by default on a fresh lexicon, matching the CLI's `DEFAULT_PACKS`.
    public static let defaults: Set<String> = ["developer", "ai", "voice-tools"]

    public private(set) var installed: Set<String>
    /// Packs with a request in flight; the card shows a spinner and refuses a second click.
    public private(set) var inFlight: Set<String>

    public init(installed: Set<String> = [], inFlight: Set<String> = []) {
        self.installed = installed
        self.inFlight = inFlight
    }

    public func isInstalled(_ name: String) -> Bool { installed.contains(name) }
    public func isBusy(_ name: String) -> Bool { inFlight.contains(name) }

    /// Optimistically flips `name` and marks it busy. Returns the state the
    /// caller should now request: true to install, false to remove.
    public mutating func beginToggle(_ name: String) -> Bool {
        let wantInstalled = !installed.contains(name)
        if wantInstalled { installed.insert(name) } else { installed.remove(name) }
        inFlight.insert(name)
        return wantInstalled
    }

    /// Settles a toggle. On failure the optimistic flip is rolled back.
    public mutating func endToggle(_ name: String, succeeded: Bool, wantedInstalled: Bool) {
        inFlight.remove(name)
        guard !succeeded else { return }
        if wantedInstalled { installed.remove(name) } else { installed.insert(name) }
    }

    /// Replaces the set from a fresh `GET /packs`, leaving in-flight packs alone
    /// so a slow list response cannot undo a toggle the user just made.
    public mutating func reconcile(with serverInstalled: [String]) {
        var next = Set(serverInstalled)
        for name in inFlight {
            if installed.contains(name) { next.insert(name) } else { next.remove(name) }
        }
        installed = next
    }
}
