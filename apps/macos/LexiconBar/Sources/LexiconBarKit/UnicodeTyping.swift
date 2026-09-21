import Foundation

/// How a replacement is cut up for posting as key events, and how much of it
/// was handed to the system.
///
/// A `CGEvent` carries a bounded unicode payload, so a replacement goes out as
/// a run of events rather than one. That makes the keystroke write the only
/// write in this app with an interior: it can stop part way. What it must never
/// do is stop in a way that leaves a state nothing can describe, and there are
/// two ways it could:
///
/// - **a gap in the middle.** The engine used to skip any chunk whose `CGEvent`
///   came back nil and carry on with the next one, so a failure half way
///   through left the first chunks and the last chunks in the field with a hole
///   between them. No arithmetic over "n of m units landed" describes that, so
///   there would be nothing to undo it with. ``post(_:size:chunk:)`` stops at
///   the first chunk it cannot post, which makes what landed always a prefix of
///   the replacement, and a prefix is exactly what `PartialWrite.overSelection`
///   is arithmetic about.
/// - **half a character.** A chunk boundary between a surrogate pair would post
///   a lone high surrogate, and the prefix of the replacement that stops there
///   is not a string at all. ``chunks(_:size:)`` moves such a boundary back one
///   unit so every stopping point is a whole scalar.
public enum UnicodeTyping {
    /// UTF-16 units per key event. Chosen long before this file existed; kept
    /// because it is what the keystroke path has always posted.
    public static let chunkSize = 20

    /// `units` cut into posting-sized ranges, in order, covering all of it, and
    /// never ending between a surrogate pair.
    public static func chunks(_ units: [UInt16], size: Int = chunkSize) -> [Range<Int>] {
        let step = max(2, size)
        var out: [Range<Int>] = []
        var start = 0
        while start < units.count {
            var end = min(start + step, units.count)
            // `end < units.count` keeps this off the final chunk, where a lead
            // surrogate is the text's own problem and not a boundary. `step` is
            // at least 2, so `end - 1` is always above `start` and the loop
            // cannot stall.
            if end < units.count, UTF16.isLeadSurrogate(units[end - 1]) { end -= 1 }
            out.append(start..<end)
            start = end
        }
        return out
    }

    /// Hands `text` to `chunk` a chunk at a time and returns how many UTF-16
    /// units were posted, stopping at the first chunk `chunk` refuses.
    ///
    /// The return value is an exact count of what was handed to the system, not
    /// an estimate: `chunk` is asked to post a whole chunk or none of it. It is
    /// still only an upper bound on what the target app has *consumed*, which
    /// is why `KeystrokeSettle` reads the field rather than trusting it.
    public static func post(_ text: String, size: Int = chunkSize,
                            chunk: (ArraySlice<UInt16>) -> Bool) -> Int {
        let units = Array(text.utf16)
        var posted = 0
        for range in chunks(units, size: size) {
            guard chunk(units[range]) else { return posted }
            posted += range.count
        }
        return posted
    }
}
