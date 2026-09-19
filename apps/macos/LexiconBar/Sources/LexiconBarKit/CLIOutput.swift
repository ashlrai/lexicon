import Foundation

/// One `original -> replacement` pair from a normalize run. The CLI's
/// NormalizeResult calls the right-hand side `replacement`; the app spec
/// calls it the canonical. Both spellings are accepted when parsing.
public struct Replacement: Equatable, Sendable {
    public let original: String
    public let replacement: String
    public let reason: String?
    public let confidence: Double?

    public init(original: String, replacement: String, reason: String? = nil, confidence: Double? = nil) {
        self.original = original
        self.replacement = replacement
        self.reason = reason
        self.confidence = confidence
    }

    /// "Ashler → Ashlr.AI"
    public var label: String { "\(original) \u{2192} \(replacement)" }
}

/// The JSON printed by `lexicon voice --toggle --paste --json` on the stop call:
/// `{ raw, output, replacements, summary, model, seconds, ms }`. Extra keys are
/// tolerated and a few likely ones (`pasted`, `error`) are read when present.
public struct VoiceResult: Equatable, Sendable {
    public let raw: String
    public let output: String
    public let replacements: [Replacement]
    public let summary: String
    public let model: String?
    public let seconds: Double?
    public let ms: Double?
    /// `pasted` if the CLI reports it; nil when absent.
    public let pasted: Bool?
    /// A top-level `error` or `pasteError` string if the CLI reports one.
    public let error: String?

    public init(raw: String, output: String, replacements: [Replacement], summary: String,
                model: String? = nil, seconds: Double? = nil, ms: Double? = nil,
                pasted: Bool? = nil, error: String? = nil) {
        self.raw = raw
        self.output = output
        self.replacements = replacements
        self.summary = summary
        self.model = model
        self.seconds = seconds
        self.ms = ms
        self.pasted = pasted
        self.error = error
    }

    /// Parses the JSON object. Returns nil if the text is not a JSON object
    /// with at least `output` or `raw`.
    public static func parse(_ text: String) -> VoiceResult? {
        guard let object = CLIOutput.jsonObject(in: text) else { return nil }
        guard object["output"] != nil || object["raw"] != nil else { return nil }
        let replacements = CLIOutput.replacements(from: object["replacements"])
        let summary = (object["summary"] as? String) ?? CLIOutput.defaultSummary(count: replacements.count)
        let pasteError = (object["pasteError"] as? String) ?? (object["paste_error"] as? String)
        // An explicit paste error means the keystroke did not land, whatever `pasted` says.
        let pasted = pasteError != nil ? false : (object["pasted"] as? Bool)
        return VoiceResult(
            raw: (object["raw"] as? String) ?? "",
            output: (object["output"] as? String) ?? (object["raw"] as? String) ?? "",
            replacements: replacements,
            summary: summary,
            model: object["model"] as? String,
            seconds: CLIOutput.number(object["seconds"]),
            ms: CLIOutput.number(object["ms"]),
            pasted: pasted,
            error: (object["error"] as? String) ?? pasteError
        )
    }
}

/// What a `lexicon voice --toggle` call meant.
public enum VoiceToggleOutcome: Equatable, Sendable {
    /// First call: the CLI started recording in the background and printed `recording`.
    case recording
    /// Second call: transcription finished.
    case finished(VoiceResult)
    /// Neither: stdout is passed through for the error message.
    case unrecognized(String)

    public static func parse(stdout: String) -> VoiceToggleOutcome {
        let trimmed = stdout.trimmingCharacters(in: .whitespacesAndNewlines)
        if let result = VoiceResult.parse(trimmed) { return .finished(result) }
        // `recording` may be bare, JSON ({"status":"recording"}), or followed by a hint line.
        let firstLine = trimmed.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? ""
        if firstLine.lowercased().hasPrefix("recording") { return .recording }
        if let object = CLIOutput.jsonObject(in: trimmed),
           let status = (object["status"] as? String) ?? (object["state"] as? String),
           status.lowercased() == "recording" {
            return .recording
        }
        return .unrecognized(trimmed)
    }
}

/// Result of `lexicon daemon --once [--paste]`, which prints text, not JSON:
///
///     2 corrections
///     "Ashler" -> "Ashlr.AI" (alias, 1.00)
///     "cooper netties" -> "Kubernetes" (phonetic, 0.85)
///
/// or `no changes` / `no changes (clipboard is empty or not text)`.
public struct ClipboardOnceResult: Equatable, Sendable {
    public let replacements: [Replacement]
    public let note: String?

    public var summary: String {
        if let note, replacements.isEmpty { return note }
        return CLIOutput.defaultSummary(count: replacements.count)
    }

    public static func parse(stdout: String) -> ClipboardOnceResult {
        // Prefer JSON if a future CLI version prints it.
        if let object = CLIOutput.jsonObject(in: stdout) {
            return ClipboardOnceResult(replacements: CLIOutput.replacements(from: object["replacements"]),
                                       note: object["summary"] as? String)
        }
        var replacements: [Replacement] = []
        var note: String?
        for rawLine in stdout.split(separator: "\n", omittingEmptySubsequences: true) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if let r = CLIOutput.parseDiffLine(line) {
                replacements.append(r)
            } else if line.lowercased().hasPrefix("no changes") {
                note = line
            }
        }
        return ClipboardOnceResult(replacements: replacements, note: note)
    }
}

/// Output of `lexicon path`:
///
///     global: /Users/me/.config/lexicon/lexicon.yaml
///     project: (none)
public struct LexiconPaths: Equatable, Sendable {
    public let global: String?
    public let project: String?

    public static func parse(stdout: String) -> LexiconPaths {
        var global: String?
        var project: String?
        for rawLine in stdout.split(separator: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("global:") {
                global = CLIOutput.pathValue(String(line.dropFirst("global:".count)))
            } else if line.hasPrefix("project:") {
                project = CLIOutput.pathValue(String(line.dropFirst("project:".count)))
            }
        }
        return LexiconPaths(global: global, project: project)
    }

    public init(global: String?, project: String?) {
        self.global = global
        self.project = project
    }
}

/// A display-oriented view of `lexicon stats --json`. The CLI prints the
/// core `LexiconStats` shape (termCount, aliasCount, totalHits, topTerms,
/// neverHit, byCategory, bySource, files); anything numeric at the top level
/// is shown so a shape change does not blank the window.
public struct StatsSummary: Equatable, Sendable {
    public struct Count: Equatable, Sendable {
        public let label: String
        public let value: Int
    }
    public let counts: [Count]
    public let topTerms: [(String, Int)]

    public static func == (lhs: StatsSummary, rhs: StatsSummary) -> Bool {
        lhs.counts == rhs.counts && lhs.topTerms.map(\.0) == rhs.topTerms.map(\.0) && lhs.topTerms.map(\.1) == rhs.topTerms.map(\.1)
    }

    public static func parse(stdout: String) -> StatsSummary? {
        guard let object = CLIOutput.jsonObject(in: stdout) else { return nil }
        let preferred = ["termCount", "aliasCount", "totalHits"]
        var counts: [Count] = []
        for key in preferred {
            if let n = CLIOutput.number(object[key]) { counts.append(Count(label: CLIOutput.humanize(key), value: Int(n))) }
        }
        for (key, value) in object.sorted(by: { $0.key < $1.key }) where !preferred.contains(key) {
            if let n = CLIOutput.number(value), !(value is Bool) {
                counts.append(Count(label: CLIOutput.humanize(key), value: Int(n)))
            } else if let array = value as? [Any], key != "topTerms" {
                counts.append(Count(label: CLIOutput.humanize(key), value: array.count))
            }
        }
        var top: [(String, Int)] = []
        if let terms = object["topTerms"] as? [[String: Any]] {
            for t in terms {
                if let c = t["canonical"] as? String, let h = CLIOutput.number(t["hits"]) { top.append((c, Int(h))) }
            }
        }
        return StatsSummary(counts: counts, topTerms: top)
    }

    /// Plain-text rendering for an alert.
    public var text: String {
        var lines = counts.map { "\($0.label): \($0.value)" }
        if !topTerms.isEmpty {
            lines.append("")
            lines.append("Top terms:")
            lines += topTerms.map { "  \($0.0) (\($0.1))" }
        }
        return lines.joined(separator: "\n")
    }
}

/// Shared helpers.
public enum CLIOutput {
    /// Finds the first JSON object in `text` (the CLI may print a warning line
    /// before it) and returns it as a dictionary.
    public static func jsonObject(in text: String) -> [String: Any]? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let start = trimmed.firstIndex(of: "{"), let end = trimmed.lastIndex(of: "}"), start < end else { return nil }
        let slice = trimmed[start...end]
        guard let data = slice.data(using: .utf8),
              let any = try? JSONSerialization.jsonObject(with: data),
              let object = any as? [String: Any] else { return nil }
        return object
    }

    static func replacements(from any: Any?) -> [Replacement] {
        guard let array = any as? [[String: Any]] else { return [] }
        return array.compactMap { r in
            guard let original = r["original"] as? String else { return nil }
            guard let replacement = (r["replacement"] as? String) ?? (r["canonical"] as? String) else { return nil }
            return Replacement(original: original, replacement: replacement,
                               reason: r["reason"] as? String, confidence: number(r["confidence"]))
        }
    }

    static func number(_ any: Any?) -> Double? {
        if let b = any as? Bool { _ = b; return nil }
        if let n = any as? NSNumber { return n.doubleValue }
        if let s = any as? String, let d = Double(s) { return d }
        return nil
    }

    /// "Corrected 2 words" / "Corrected 1 word" / "No changes".
    public static func defaultSummary(count: Int) -> String {
        switch count {
        case 0: return "No changes"
        case 1: return "Corrected 1 word"
        default: return "Corrected \(count) words"
        }
    }

    /// Parses one diff line: `"Ashler" -> "Ashlr.AI" (alias, 1.00)`.
    static func parseDiffLine(_ line: String) -> Replacement? {
        guard line.hasPrefix("\""), let arrow = line.range(of: "\" -> \"") else { return nil }
        let original = String(line[line.index(after: line.startIndex)..<arrow.lowerBound])
        let rest = line[arrow.upperBound...]
        guard let closeQuote = rest.range(of: "\"", options: .backwards) ?? rest.range(of: "\" (") else { return nil }
        // The replacement ends at the last `"` before ` (` when a reason follows, else at the last quote.
        var replacementEnd = closeQuote.lowerBound
        var reason: String?
        var confidence: Double?
        if let paren = rest.range(of: "\" (", options: .backwards), rest.hasSuffix(")") {
            replacementEnd = paren.lowerBound
            let inner = rest[paren.upperBound..<rest.index(before: rest.endIndex)]
            let parts = inner.split(separator: ",", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            reason = parts.first
            if parts.count > 1 { confidence = Double(parts[1]) }
        }
        let replacement = String(rest[rest.startIndex..<replacementEnd])
        return Replacement(original: original, replacement: replacement, reason: reason, confidence: confidence)
    }

    static func pathValue(_ raw: String) -> String? {
        let v = raw.trimmingCharacters(in: .whitespaces)
        if v.isEmpty || v == "(none)" { return nil }
        return v
    }

    static func humanize(_ key: String) -> String {
        var out = ""
        for ch in key {
            if ch.isUppercase { out += " " + String(ch).lowercased() } else { out.append(ch) }
        }
        return out.prefix(1).uppercased() + out.dropFirst()
    }

    /// Whether a voice/clipboard run reported that the paste keystroke failed.
    /// The CLI's own message names Accessibility, and the JSON may carry
    /// `pasted: false` or an error string. Any of those counts.
    public static func indicatesPasteFailure(result: VoiceResult?, stderr: String, exitCode: Int32, pasteRequested: Bool) -> Bool {
        guard pasteRequested else { return false }
        if let result {
            if result.pasted == false { return true }
            if let e = result.error?.lowercased(), e.contains("paste") || e.contains("accessibility") { return true }
        }
        let err = stderr.lowercased()
        if err.contains("--paste failed") || err.contains("accessibility") { return true }
        if exitCode != 0 && err.contains("paste") { return true }
        return false
    }
}
