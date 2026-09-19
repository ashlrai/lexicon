// swift-tools-version: 5.9
// LexiconBar: a menu bar front end for the `lexicon` CLI (macOS 13+).
// No third-party dependencies. `LexiconBarKit` holds the pure, testable logic
// (hotkey encoding, CLI output parsing, restart backoff, CLI discovery);
// `LexiconBar` is the AppKit/SwiftUI executable.
import PackageDescription

let package = Package(
    name: "LexiconBar",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "LexiconBar", targets: ["LexiconBar"]),
        .library(name: "LexiconBarKit", targets: ["LexiconBarKit"]),
    ],
    targets: [
        .target(name: "LexiconBarKit"),
        .executableTarget(
            name: "LexiconBar",
            dependencies: ["LexiconBarKit"]
        ),
        .testTarget(
            name: "LexiconBarKitTests",
            dependencies: ["LexiconBarKit"]
        ),
    ]
)
