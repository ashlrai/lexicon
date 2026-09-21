import XCTest
@testable import LexiconBarKit

/// How much of a replacement went out, and the shape of what is left when not
/// all of it did.
///
/// The recovery in `PartialWrite` is arithmetic about a *prefix*: the first n
/// units of the replacement are in the field and the rest are not. The posting
/// loop is what has to make that true. It used to skip a chunk whose `CGEvent`
/// could not be built and carry on with the next one, which leaves a hole in
/// the middle of the replacement instead of a prefix, and no arithmetic here
/// describes a hole. These tests are the reason the whole recovery is allowed
/// to assume a prefix.
final class UnicodeTypingTests: XCTestCase {
    /// Long enough to be several chunks, not a whole number of them, and with
    /// no period that divides the chunk size. A repeating fixture hides the
    /// bug this file is about: chunk three of "abcdeabcde..." is identical to
    /// chunk two, so dropping chunk two leaves something that still reads as a
    /// prefix.
    private let long = String((0..<65).map { Character(UnicodeScalar(UInt8(97 + $0 % 23))) })

    /// Posts through a closure that refuses the chunk at `failAt`, and reports
    /// what the closure was actually handed.
    private func post(_ text: String, size: Int = UnicodeTyping.chunkSize, failAt: Int? = nil)
        -> (posted: Int, handed: [UInt16], calls: Int) {
        var handed: [UInt16] = []
        var calls = 0
        let posted = UnicodeTyping.post(text, size: size) { chunk in
            defer { calls += 1 }
            if calls == failAt { return false }
            handed.append(contentsOf: chunk)
            return true
        }
        return (posted, handed, calls)
    }

    func testEveryChunkThatGoesIsCounted() {
        let result = post(long)
        XCTAssertEqual(result.posted, long.utf16.count)
        XCTAssertEqual(result.handed, Array(long.utf16))
    }

    /// The reason this function returns a number at all. A chunk that cannot be
    /// posted ends the write; the chunks after it are not sent anyway.
    func testPostingStopsAtTheFirstChunkItCannotSend() {
        let result = post(long, failAt: 1)

        XCTAssertEqual(result.posted, UnicodeTyping.chunkSize)
        // Two calls: the one that went, and the one that refused. Skipping the
        // refused chunk and carrying on would make this three.
        XCTAssertEqual(result.calls, 2)
    }

    /// The property the recovery depends on: whatever was posted is a prefix of
    /// the replacement, never a prefix and a suffix with a gap between them.
    func testWhatWasPostedIsAlwaysAPrefix() {
        let units = Array(long.utf16)
        for failAt in 0..<4 {
            let result = post(long, failAt: failAt)
            XCTAssertEqual(result.posted, result.handed.count, "failing at chunk \(failAt)")
            XCTAssertEqual(result.handed, Array(units.prefix(result.posted)), "failing at chunk \(failAt)")
        }
    }

    func testNothingGoesWhenTheFirstChunkIsRefused() {
        let result = post(long, failAt: 0)
        XCTAssertEqual(result.posted, 0)
        XCTAssertTrue(result.handed.isEmpty)
    }

    // MARK: surrogate pairs

    /// A boundary that falls between a surrogate pair would post half a
    /// character, and the prefix of the replacement that stops there is not a
    /// string. The boundary moves back one unit instead.
    func testAChunkNeverEndsBetweenASurrogatePair() {
        // Rockets are two UTF-16 units each, so a 21-unit chunk would land
        // mid-pair on every odd boundary.
        let rockets = String(repeating: "\u{1F680}", count: 30)
        let units = Array(rockets.utf16)

        for size in 2...12 {
            let chunks = UnicodeTyping.chunks(units, size: size)
            XCTAssertEqual(chunks.map(\.count).reduce(0, +), units.count, "size \(size)")
            XCTAssertEqual(chunks.first?.lowerBound, 0, "size \(size)")
            for chunk in chunks.dropLast() {
                XCTAssertFalse(UTF16.isLeadSurrogate(units[chunk.upperBound - 1]),
                               "size \(size) split a surrogate pair at \(chunk.upperBound)")
            }
        }
    }

    /// And so every point the write can stop at is a whole string. A prefix cut
    /// mid-pair decodes to a replacement character, which would make the
    /// hypothesis `PartialWrite` builds match no field that ever existed.
    func testEveryStoppingPointIsAWholeString() {
        let mixed = "ship \u{1F680} it \u{1F680} now, all of it, \u{1F680} today"
        let units = Array(mixed.utf16)
        var at = 0

        for chunk in UnicodeTyping.chunks(units, size: 6) {
            at = chunk.upperBound
            let prefix = String(decoding: units.prefix(at), as: UTF16.self)
            XCTAssertFalse(prefix.unicodeScalars.contains("\u{FFFD}"), "prefix of \(at) units is not whole")
            XCTAssertTrue(mixed.hasPrefix(prefix), "prefix of \(at) units is not a prefix")
        }
        XCTAssertEqual(at, units.count)
    }

    /// Text shorter than one chunk still goes in one call, and a lead surrogate
    /// at the very end is the text's own problem rather than a boundary.
    func testShortTextIsOneChunk() {
        XCTAssertEqual(UnicodeTyping.chunks(Array("hi".utf16)), [0..<2])
        XCTAssertTrue(UnicodeTyping.chunks([]).isEmpty)
    }
}
