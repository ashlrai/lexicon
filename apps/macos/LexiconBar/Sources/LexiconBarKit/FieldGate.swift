import Foundation

/// A focused field as the portable half sees it: what the Accessibility tree
/// says *about* the field, and the one call that pulls the user's own text
/// across the process boundary.
///
/// The split is the whole point. `bundleID` and `hints` can be inspected for
/// free, because they are metadata the window server and the Accessibility
/// tree hand over without touching the field's contents. `readValue()` is the
/// first moment the user's text enters this process, so `FieldGate` gets to
/// decide before it is ever called.
public protocol InspectableField {
    /// The owning app's bundle id, as `AppExclusions` matches it.
    var bundleID: String? { get }

    /// The field's and its window's labels. Metadata, never the value.
    var hints: SecretFieldHeuristic.FieldHints { get }

    /// The field's text. Only ever called for a field the gate admitted.
    func readValue() -> String?
}

/// The outcome of asking the gate for a field's text.
public struct FieldRead: Equatable, Sendable {
    /// The text, or nil when the field was refused or could not be read.
    public let value: String?
    /// Why the field was refused, or nil when it was admitted.
    public let refusal: String?

    public init(value: String?, refusal: String?) {
        self.value = value
        self.refusal = refusal
    }

    public var refused: Bool { refusal != nil }
}

/// The one place that decides whether a field's contents may be read at all.
///
/// This used to live a layer up, in `FixEngine.makeDetector`: `FocusWatcher`
/// read every focused field and cached it, and the exclusion list and
/// `SecretFieldHeuristic` only decided, afterwards, whether to build a
/// `BurstDetector` for text already held. That made the refusal a policy about
/// what we *do* with a secret rather than about whether we hold one, and a
/// vault's notes field or a TOTP box in an app on nobody's exclusion list sat
/// in the watcher's `lastValue`, refreshed twice a second, for as long as it
/// had focus. Nothing was sent or logged, but a crash dump or an attached
/// debugger would have carried it, which is exactly the reach the threat model
/// says this app does not have.
///
/// So the decision moved in front of the read. A refused field is never asked
/// for its value: `read(_:exclusions:)` returns without calling
/// `InspectableField.readValue()` at all, which is what `FieldGateTests`
/// asserts. The checks downstream in `FixEngine` stay where they are, as
/// defence in depth rather than as the guard itself.
public enum FieldGate {
    /// Why this field's contents must never be read, or nil when they may be.
    ///
    /// Pure string work over metadata the caller already has, so it is cheap
    /// enough to re-run on every poll tick. That matters: the user can add an
    /// app to the exclusion list from the menu while that app still holds
    /// focus, and the refusal has to take effect then rather than at the next
    /// focus change.
    public static func refuse(exclusions: AppExclusions,
                              bundleID: String?,
                              hints: SecretFieldHeuristic.FieldHints) -> String? {
        if exclusions.isExcluded(bundleID) {
            return "\(bundleID ?? "the app") is on the exclusion list"
        }
        if let term = SecretFieldHeuristic.match(hints) {
            return "the field's labels look like a secret (\(term))"
        }
        return nil
    }

    /// The field's text, or a refusal. `field` is asked for its value only
    /// when it is admitted.
    public static func read(_ field: InspectableField, exclusions: AppExclusions) -> FieldRead {
        if let refusal = refuse(exclusions: exclusions, bundleID: field.bundleID, hints: field.hints) {
            return FieldRead(value: nil, refusal: refusal)
        }
        return FieldRead(value: field.readValue(), refusal: nil)
    }
}
