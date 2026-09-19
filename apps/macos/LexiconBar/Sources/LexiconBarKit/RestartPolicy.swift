import Foundation

/// Decides whether a supervised child (`lexicon daemon`, `lexicon serve`)
/// should be restarted after it exits unexpectedly. Pure so it can be tested.
///
/// Rules: wait `backoff` seconds before each restart, give up after
/// `maxRestarts` consecutive restarts. A child that stayed up for at least
/// `stableAfter` seconds counts as healthy and resets the counter, so a
/// crash a day later gets the full budget again.
public struct RestartPolicy: Equatable, Sendable {
    public let backoff: TimeInterval
    public let maxRestarts: Int
    public let stableAfter: TimeInterval
    public private(set) var restarts: Int = 0

    public init(backoff: TimeInterval = 5, maxRestarts: Int = 5, stableAfter: TimeInterval = 60) {
        self.backoff = backoff
        self.maxRestarts = maxRestarts
        self.stableAfter = stableAfter
    }

    /// Call when the child exits without being asked to. `uptime` is how long
    /// it ran. Returns the delay to wait before relaunching, or nil when the
    /// restart budget is spent.
    public mutating func delayBeforeRestart(afterUptime uptime: TimeInterval) -> TimeInterval? {
        if uptime >= stableAfter { restarts = 0 }
        guard restarts < maxRestarts else { return nil }
        restarts += 1
        return backoff
    }

    /// Call when the user deliberately stops or starts the child.
    public mutating func reset() { restarts = 0 }

    public var isExhausted: Bool { restarts >= maxRestarts }
}
